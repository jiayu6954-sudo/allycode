import { WorkspaceSnapshots } from "../src/storage/workspace-snapshots.js";
import { BUILD_INFO } from "../src/build-info.js";
import { SteeringQueue, recoverSteering } from "../src/agent/steering.js";
import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import { runAgentLoop } from "../src/agent/loop.js";
import { executionAllowance } from "../src/agent/execution-budget.js";
import { runResearchLoop } from "../src/agent/research-loop.js";
import { buildSystemPrompt } from "../src/agent/system-prompt.js";
import { loadSettings } from "../src/config/settings.js";
import { loadClaudeMd } from "../src/memory/claude-md.js";
import { extractAndSaveMemory } from "../src/memory/long-term.js";
import {
  accountSessionCall,
  assertSessionWorkspace,
  createSession,
  commitSessionDeletions,
  deriveTitle,
  loadSession,
  rollbackSessionDeletions,
  saveSession,
  stageSessionDeletions,
} from "../src/memory/session.js";
import { MCPRegistry } from "../src/mcp/registry.js";
import { PermissionManager } from "../src/permissions/manager.js";
import { createProvider } from "../src/providers/index.js";
import { SandboxManager } from "../src/sandbox/manager.js";
import {
  getAgentDatabase,
  type SessionDeletionResult,
  type TaskRecord,
} from "../src/storage/agent-database.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { PermissionDecision, PermissionRequest } from "../src/types/permissions.js";
import type { AllyCodeSettings } from "../src/config/schema.js";
import type {
  AgentStartRequest,
  DesktopAgentEvent,
  DeleteSessionsRequest,
  DeleteSessionsResult,
  TaskSummary,
} from "./shared.js";
import {
  analyzeAgentTask,
  createDiagnosticExport,
  type AgentMonitorReport,
} from "../src/observability/agent-monitor.js";
import { assertSafeWorkspaceRoot } from "../src/tools/path-guard.js";
import { evaluateCompletionEvidence } from "../src/observability/completion-gate.js";
import { consumedTokens, withModelAccounting, type ModelCallRecord } from "../src/providers/model-gateway.js";
import { stopAllServicesAndWait } from "../src/tools/service.js";
import { reclaimStaleBrowserProfiles } from "../src/tools/browser.js";
import { latestDeclaredPlan } from "../src/observability/delivery-receipt.js";
import { buildExecutionReceipt, renderExecutionReceipt } from "../src/observability/execution-receipt.js";
import { deriveTaskState, renderTaskState } from "../src/agent/durable-task-state.js";
import { buildResumePrompt } from "./resume-prompt.js";
import { latestPhaseCheckpoint, selectedPhaseOption, renderPhaseCheckpoint } from "../src/agent/phase-workflow.js";
import {
  commandForEngine,
  getExternalAgentEngine,
  resolveAgentEngine,
} from "../src/engines/registry.js";
import type { AgentEngineId } from "../src/engines/types.js";

interface ActiveRun {
  controller: AbortController;
  taskId: string;
  steering: SteeringQueue;
  acceptsSteering: boolean;
}

interface PendingPermission {
  runId: string;
  taskId: string;
  resolve: (decision: PermissionDecision) => void;
}

export class DesktopAgentService {
  private activeRuns = new Map<string, ActiveRun>();
  private permissionResolvers = new Map<string, PendingPermission>();
  private taskPermissionAllowances = new Map<string, Set<string>>();
  private readonly database = getAgentDatabase();

  constructor(
    private webContents: () => WebContents | null,
    private settingsLoader: () => Promise<AllyCodeSettings> = loadSettings,
  ) {
    this.database.recoverInterruptedTasks();
  }

  start(request: AgentStartRequest): { runId: string; taskId: string } {
    assertSafeWorkspaceRoot(request.cwd);
    const runId = randomUUID();
    const controller = new AbortController();
    const project = this.database.resolveProject(request.cwd);
    if ([...this.activeRuns.values()].some((active) => this.database.getTask(active.taskId)?.projectId === project.id)) throw new Error("该项目已有运行任务，请先暂停再启动新任务。");
    const requestedTask = request.taskId
      ? this.database.getTask(request.taskId)
      : null;
    if (requestedTask && requestedTask.projectId !== project.id) {
      throw new Error("Task does not belong to the selected project.");
    }
    if (request.resume && !requestedTask) {
      throw new Error("找不到要恢复的任务。");
    }
    if (request.resume && requestedTask && !["paused", "failed"].includes(requestedTask.status)) {
      throw new Error("只有已暂停或执行失败的任务可以恢复。");
    }
    if (request.taskId && !requestedTask) throw new Error("找不到指定任务，不能绑定其他会话。");
    if (requestedTask && request.sessionId && requestedTask.sessionId !== request.sessionId) throw new Error("任务与会话不匹配。");
    // A window continues only its explicitly selected task. New tasks get new sessions.
    const task = requestedTask ?? this.database.createTask({
      projectId: project.id,
      title: deriveTitle(request.prompt || "继续未完成任务"),
      goal: request.prompt || "继续未完成任务",
    });
    const phase = latestPhaseCheckpoint(this.database.listMonitorEvents(task.id));
    const selected = phase?.phase.kind === "decision" ? selectedPhaseOption(phase.phase,request.prompt) : undefined;
    if (selected && phase) this.database.appendEvent(task.id,"phase_decision_confirmed",{checkpointId:phase.id,optionId:selected,source:"user_message"},runId);
    this.database.updateTaskStatus(task.id, "running", { runId });
    const steering = new SteeringQueue();
    for (const item of recoverSteering(this.database.listMonitorEvents(task.id))) steering.enqueue(item);
    this.activeRuns.set(runId, { controller, taskId: task.id, steering, acceptsSteering:false });
    this.sendTaskStatus(runId, task.id);
    void this.execute(runId, task.id, request, controller).finally(() => {
      this.activeRuns.delete(runId);
    });
    return { runId, taskId: task.id };
  }

  abort(runId: string): void {
    const active = this.activeRuns.get(runId);
    active?.controller.abort();
    if (active) {
      this.database.updateTaskStatus(active.taskId, "paused", {
        runId,
        note: "用户暂停任务",
      });
      this.sendTaskStatus(runId, active.taskId);
    }
    for (const [requestId, pending] of this.permissionResolvers) {
      if (pending.runId === runId) {
        pending.resolve("deny");
        this.permissionResolvers.delete(requestId);
      }
    }
  }

  steer(runId: string, text: string): {id:string;status:"queued"} {
    const active = this.activeRuns.get(runId);
    if (!active || active.controller.signal.aborted) throw new Error("本轮已结束或暂停，补充内容尚未发送。请作为下一条消息继续。");
    if (!active.acceptsSteering) throw new Error("当前引擎尚未就绪、正在收尾，或不支持执行中补充。内容仍在输入框；可稍后重试或暂停后发送。");
    if(typeof text !== "string")throw new Error("补充内容格式无效。");
    const item = {id:randomUUID(),text:text.trim(),createdAt:new Date().toISOString()};
    active.steering.enqueue(item);
    try { this.database.appendEvent(active.taskId,"task_steering_queued",item,runId); }
    catch(error){active.steering.acknowledge([item.id]);throw error;}
    for(const [id,pending] of this.permissionResolvers){
      if(pending.runId!==runId)continue;
      pending.resolve("deny");this.permissionResolvers.delete(id);
    }
    return {id:item.id,status:"queued"};
  }

  resolvePermission(requestId: string, decision: PermissionDecision): void {
    const pending = this.permissionResolvers.get(requestId);
    pending?.resolve(decision);
    if (pending) {
      this.database.appendEvent(pending.taskId, "permission_resolved", {
        requestId,
        decision,
      }, pending.runId);
      this.database.updateTaskStatus(pending.taskId, "running", {
        runId: pending.runId,
        note: decision === "deny" ? "用户拒绝操作，等待 Agent 收尾" : "权限已授予",
      });
      this.sendTaskStatus(pending.runId, pending.taskId);
    }
    this.permissionResolvers.delete(requestId);
  }

  listTasks(cwd?: string): TaskSummary[] {
    if (!cwd) return this.database.listTasks().map((task) => this.toTaskSummary(task));
    const project = this.database.resolveProject(cwd);
    return this.database.listTasks(project.id).map((task) => this.toTaskSummary(task));
  }

  getMonitorReport(taskId: string): AgentMonitorReport {
    const task = this.database.getTask(taskId);
    if (!task) throw new Error("找不到要监控的任务。");
    return analyzeAgentTask(
      task,
      this.database.listMonitorEvents(taskId),
      { totalEventCount: this.database.countEvents(taskId) },
    );
  }

  getDiagnosticExport(taskId: string): AgentMonitorReport {
    return createDiagnosticExport(this.getMonitorReport(taskId));
  }

  async deleteSessions(request: DeleteSessionsRequest): Promise<DeleteSessionsResult> {
    const sessionIds = [...new Set(request.sessionIds.map((id) => id.trim()).filter(Boolean))];
    if (sessionIds.length === 0) throw new Error("请至少选择一个会话。");
    const activeSessionIds = new Set(
      [...this.activeRuns.values()]
        .map((run) => this.database.getTask(run.taskId)?.sessionId)
        .filter((id): id is string => Boolean(id)),
    );
    if (sessionIds.some((id) => activeSessionIds.has(id))) {
      throw new Error("运行中的会话不能删除，请先暂停任务。");
    }

    const staged = await stageSessionDeletions(sessionIds);
    let result: SessionDeletionResult;
    try {
      result = this.database.deleteSessionData(
        sessionIds,
        request.includeDurableTasks,
      );
    } catch (error) {
      await rollbackSessionDeletions(staged);
      throw error;
    }
    // The database is now committed. Never resurrect a visible session file if
    // final tombstone cleanup fails; a later maintenance pass can remove it.
    await commitSessionDeletions(staged);
    return { deletedSessionCount: staged.length, ...result };
  }

  resumeTask(taskId: string): { runId: string; taskId: string } {
    const task = this.database.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    const project = this.database.getProject(task.projectId);
    if (!project) throw new Error("Project not found.");
    if (!task.checkpoint) throw new Error("Task has no recoverable checkpoint.");
    return this.start({
      prompt: buildResumePrompt(task),
      cwd: project.primaryPath,
      sessionId: task.sessionId,
      taskId,
      resume: true,
    });
  }

  continuePhase(taskId:string,toolId:string,optionId?:string):{runId:string;taskId:string} {
    const task=this.database.getTask(taskId);
    if(!task || task.status!=="paused") throw new Error("阶段必须已保存并暂停后才能继续。");
    const events=this.database.listMonitorEvents(taskId);
    const phase=latestPhaseCheckpoint(events);
    if(!phase || phase.toolId!==toolId) throw new Error("该阶段卡片已过期，请使用最新交接记录。");
    if(events.some(event=>["phase_child","phase_decision_confirmed"].includes(event.eventType) && (event.payload as {checkpointId?:number}).checkpointId===phase.id)) throw new Error("该阶段已选择或交接，请打开后续任务继续。");
    const project=this.database.getProject(task.projectId);
    if(!project) throw new Error("项目不存在。");
    if(phase.phase.kind==="decision") {
      if(!phase.phase.options.some(option=>option.id===optionId)) throw new Error("请选择有效的方案。");
      return this.start({cwd:project.primaryPath,taskId,sessionId:task.sessionId,prompt:`选择方案 ${optionId}`});
    }
    // A child phase gets a new session and permission cache. Only public handoff
    // facts are copied, never provider continuation state or other task memory.
    const parent=events.find(event=>event.eventType==="phase_parent")?.payload as {rootGoal?:string}|undefined;
    const rootGoal=(parent?.rootGoal??task.goal).slice(0,6000);
    const prompt=`继续项目的下一阶段：${phase.phase.title}\n原始目标：${rootGoal}\n来源任务：${taskId}\n以下是上一阶段的公开交接线索，请先核对项目文档、实际文件和验收范围，不能把摘要当成事实证明：\n${renderPhaseCheckpoint(phase.phase)}\n为当前阶段重新列计划并执行。`;
    const started=this.start({cwd:project.primaryPath,prompt});
    this.database.appendEvent(started.taskId,"phase_parent",{taskId,checkpointId:phase.id,document:phase.phase.document,rootGoal});
    this.database.appendEvent(taskId,"phase_child",{taskId:started.taskId,checkpointId:phase.id});
    return started;
  }

  sessionReceipts(sessionId:string):Array<{runId:string;rendered:string;generatedAt:string}> {
    return this.database.listTasks().filter(task=>task.sessionId===sessionId).flatMap(task=>this.database.listMonitorEvents(task.id)
      .filter(event=>event.eventType==="execution_receipt")
      .map(event=>{const receipt=event.payload as import("../src/observability/execution-receipt.js").ExecutionReceipt;return {runId:receipt.runId,generatedAt:receipt.generatedAt,rendered:renderExecutionReceipt(receipt)};}));
  }

  private async execute(
    runId: string,
    taskId: string,
    request: AgentStartRequest,
    controller: AbortController,
  ): Promise<void> {
    const mcp = new MCPRegistry();
    const streamSummary = {
      textDeltaCount: 0,
      textChars: 0,
      thinkingDeltaCount: 0,
      thinkingChars: 0,
      progressChunkCount: 0,
      progressChars: 0,
      /** Input tokens the history budget kept off the wire this run. */
      contextTokensSaved: 0,
      contextTrims: 0,
    };
    try {
      if (!request.resume) {
        try { const snapshot = await new WorkspaceSnapshots(request.cwd).create("任务开始：" + request.prompt.slice(0, 60)); this.database.appendEvent(taskId, "workspace_snapshot", { id: snapshot.id, revision: snapshot.revision }, runId); }
        catch (error) { this.database.appendEvent(taskId, "workspace_snapshot_unavailable", { message: String(error) }, runId); }
      }
      const settings = await this.settingsLoader();
      const task = this.database.getTask(taskId);
      if (!task) throw new Error("Task state disappeared before execution.");
      const selectedEngine = resolveAgentEngine(settings);
      if (selectedEngine !== "native") {
        const external = getExternalAgentEngine(selectedEngine);
        const command = commandForEngine(settings, selectedEngine);
        const health = await external.health(command);
        this.database.appendEvent(taskId, "agent_engine_health", health, runId);
        if (health.selectable) {
          await this.executeExternal(
            runId,
            taskId,
            request,
            controller,
            settings,
            selectedEngine,
            command,
          );
          return;
        }
        if (!settings.agentEngine.fallbackToNative) {
          throw new Error(`${health.engine.name} 当前不可用：${health.detail}`);
        }
        this.database.appendEvent(taskId, "agent_engine_fallback", {
          requestedEngine: selectedEngine,
          resolvedEngine: "native",
          reason: health.detail,
        }, runId);
      }
      const provider = createProvider(settings);
      const active = this.activeRuns.get(runId)!;
      active.acceptsSteering = true;
      const priorEvents = this.database.listMonitorEvents(taskId);
      const priorModelTurns = priorEvents.filter((event) => event.eventType === "agent_usage" && (!((event.payload as {purpose?: string})?.purpose) || (event.payload as {purpose?: string}).purpose === "main")).length;
      const priorToolCalls = priorEvents.filter((event) => event.eventType === "agent_tool_start").length;
      const allowance = executionAllowance(settings.executionBudget, priorModelTurns, priorToolCalls);
      const remainingTaskTurns = allowance.remainingTaskTurns;
      if (allowance.maxIterations <= 0 || allowance.maxToolCalls <= 0) {
        throw new Error(
          "任务已达到手动启用的累计预算。" +
          "进度和记忆保留；请在设置中关闭累计预算或提高上限，然后在本任务继续。",
        );
      }
      this.database.appendEvent(taskId, "agent_run_context", {
        build: BUILD_INFO,
        engine: "native",
        provider: settings.provider,
        model: settings.model,
        protocol: settings.providerProtocol,
        reasoningMode: settings.reasoning.mode,
        reasoningEffort: settings.reasoning.effort,
        sandboxEnabled: settings.sandbox.enabled,
        skillCount: (await import("../src/skills/loader.js")).matchSkills(
          (await import("../src/skills/loader.js")).loadSkills(),
          request.prompt,
        ).length,
        mcpServerCount: settings.mcpServers.filter((server) => server.enabled).length,
      }, runId);
      // A resumed run inherits the plan from its checkpoint, but a run that
      // never re-issued plan_update writes a checkpoint without one. Recover
      // the declaration from the durable event log instead of losing it.
      let currentPlan = task.checkpoint?.plan?.length
        ? task.checkpoint.plan
        : latestDeclaredPlan(this.database.listMonitorEvents(taskId));
      const loaded = task.sessionId
        ? await loadSession(task.sessionId)
        : null;
      const session = loaded ?? createSession(request.cwd, settings.model);
      if (task.sessionId && !loaded) throw new Error("任务会话文件缺失，已停止续接以避免丢失原有上下文。");
      assertSessionWorkspace(session, request.cwd);
      const unsettled = new Map<string, ModelCallRecord>();
      for (const related of this.database.listTasks().filter((item) => item.sessionId === session.id)) {
        for (const event of this.database.listMonitorEvents(related.id)) {
          if (event.eventType !== "agent_model_call") continue;
          const call = (event.payload as { record?: ModelCallRecord }).record;
          if (call?.id) unsettled.set(call.id, call);
        }
      }
      for (const call of unsettled.values()) accountSessionCall(session, call.status === "reserved" ? { ...call, status: "unknown" } : call);
      if (!session.title) session.title = deriveTitle(request.prompt);
      const checkpointHistory = request.resume
        ? task.checkpoint?.conversationHistory
        : undefined;
      const conversationHistory = checkpointHistory
        ? [
            ...checkpointHistory,
            { role: "user" as const, content: request.prompt },
          ]
        : [
            ...session.messages,
            { role: "user" as const, content: request.prompt },
          ];

      session.messages = conversationHistory;
      session.cwd = request.cwd;
      session.model = settings.model;
      await saveSession(session);
      this.database.attachSession(taskId, session.id);
      this.database.checkpointTask(taskId, {
        reason: "initial",
        conversationHistory,
        note: request.resume ? "从持久化检查点恢复" : "用户任务已持久化",
      }, runId);

      await mcp.connect(settings.mcpServers.filter((server) => server.enabled));
      const sandbox = settings.sandbox.enabled
        ? new SandboxManager(settings.sandbox, { workspaceId: taskId })
        : undefined;
      const permissionManager = new PermissionManager(
        settings,
        (permissionRequest) => this.askPermission(runId, taskId, permissionRequest),
        Boolean(sandbox),
        this.taskPermissionAllowances.get(taskId) ?? this.createTaskPermissionCache(taskId),
      );
      const researchRunner = (
        query: string,
        depth: "basic" | "deep",
        onProgress: (message: string) => void,
      ) => runResearchLoop({
        query,
        depth,
        provider,
        model: settings.model,
        maxTokens: settings.maxTokens,
        searchConfig: settings.search,
        cwd: request.cwd,
        onProgress,
        signal: controller.signal,
      });
      const tools = new ToolRegistry(
        request.cwd,
        mcp,
        sandbox,
        settings.search,
        researchRunner,
        undefined,
        settings.hooks,
        settings.github.token,
      );
      tools.setTaskScope(taskId);
      tools.setVerificationReader(()=>evaluateCompletionEvidence(request.cwd,this.database.listMonitorEvents(taskId)));
      const phaseEvents=this.database.listMonitorEvents(taskId);
      const phase=latestPhaseCheckpoint(phaseEvents);
      const decisionPending=phase?.phase.kind==="decision" && !phaseEvents.some(event=>event.eventType==="phase_decision_confirmed" && (event.payload as {checkpointId?:number}).checkpointId===phase.id);
      tools.setDecisionPending(Boolean(decisionPending));
      const projectContext = await loadClaudeMd(
        request.cwd,
        settings.context.claudeMdPaths,
      );
      const basePrompt = await buildSystemPrompt(
        request.cwd,
        projectContext,
        settings,
        null,
        request.prompt,
        session.id,
      );

      // A resumed run starts from verified state rather than re-reading the
      // project: that is what keeps the context saving from turning into extra
      // tool rounds. It rides in the system prompt because it is derived
      // working context, not conversation — the canonical record stays clean.
      let systemPrompt = basePrompt;
      if(decisionPending) systemPrompt += "\n当前方案尚未收到明确选择。实施工具被暂停；请修订方案或请用户回复‘选择方案 A’（使用实际方案编号），不要把继续/恢复当成授权。";
      if (request.resume) {
        const priorState = deriveTaskState(
          this.database.listMonitorEvents(taskId),
          conversationHistory,
        );
        systemPrompt = `${systemPrompt}\n\n${renderTaskState(priorState)}`;
        this.database.appendEvent(taskId, "resume_state_injected", {
          modifiedFiles: priorState.modifiedFiles.length,
          unresolvedErrors: priorState.unresolvedErrors.length,
          nextAction: priorState.nextAction,
        }, runId);
      }

      const result = await runAgentLoop(
        provider,
        {
          model: settings.model,
          maxTokens: settings.maxTokens,
          systemPrompt,
          conversationHistory,
          compactionState: session.compactionState,
          requirePlan:true,
          initialPlan:currentPlan,
          readSteering:()=>active.steering.peek(),
          onSteeringApplied:(items)=>{
            for(const item of items)this.database.appendEvent(taskId,"task_steering_applied",{id:item.id},runId);
            active.steering.acknowledge(items.map(item=>item.id));
          },
          onCompactionChange: async (state) => { session.compactionState = state; await saveSession(session); },
          onEvent: (event) => {
            if (event.type === "model_call") accountSessionCall(session, event.record);
            if (event.type === "text_delta") {
              streamSummary.textDeltaCount += 1;
              streamSummary.textChars += event.delta.length;
            } else if (event.type === "thinking_delta") {
              streamSummary.thinkingDeltaCount += 1;
              streamSummary.thinkingChars += event.delta.length;
            } else if (event.type === "context_budget") {
              // Small metadata only: preserve per-call evidence for cost audits.
              this.database.appendEvent(taskId, "agent_context_budget", event, runId);
              streamSummary.contextTokensSaved += event.beforeTokens - event.afterTokens;
              streamSummary.contextTrims += 1;
            } else if (event.type === "tool_progress") {
              streamSummary.progressChunkCount += 1;
              streamSummary.progressChars += event.chunk.length;
            } else {
              this.database.appendEvent(taskId, `agent_${event.type}`, event, runId);
            }
            if (event.type === "plan_update") {
              currentPlan = event.items;
              const current = this.database.getTask(taskId);
              if (current?.checkpoint) {
                this.database.checkpointTask(taskId, {
                  ...current.checkpoint,
                  plan: event.items,
                  note: event.explanation ?? "工作计划已更新",
                }, runId);
              }
            }
            this.send({ runId, event });
          },
          onHistoryChange: async (history) => {
            session.messages = history;
            await saveSession(session);
            this.database.checkpointTask(taskId, {
              reason: "iteration",
              conversationHistory: history,
              plan: currentPlan,
              note: "Agent 迭代完成，已保存可恢复状态",
            }, runId);
          },
          signal: controller.signal,
          tokenBudget: {
            warningThreshold: settings.tokenBudget.warningThreshold,
            hardLimit: settings.tokenBudget.hardLimit,
            priorTokens:
              consumedTokens(session.totalUsage),
          },
          maxIterations: allowance.maxIterations,
          toolBudget: {
            hardLimit: allowance.maxToolCalls,
            priorToolCalls: 0,
          },
          historyBudget: {
            maxContextTokens: settings.context.maxContextTokens,
            keepRecentMessages: settings.context.keepRecentMessages,
          },
        },
        tools,
        permissionManager,
      );

      active.acceptsSteering = false;
      session.messages = result.updatedHistory;
      session.model = settings.model;
      session.cwd = request.cwd;
      await saveSession(session);
      this.database.attachSession(taskId, session.id);

      if (controller.signal.aborted) {
        this.database.checkpointTask(taskId, {
          reason: "paused",
          conversationHistory: result.updatedHistory,
          usage: result.totalUsage,
          plan: currentPlan,
          note: "任务已暂停，可从此检查点继续",
        }, runId);
        this.database.updateTaskStatus(taskId, "paused", { runId });
        this.sendTaskStatus(runId, taskId);
        this.send({ runId, type: "paused", sessionId: session.id, taskId });
        return;
      }

      if (result.stopReason === "max_iterations" || result.stopReason === "tool_budget" || result.stopReason === "checkpoint") {
        const events = this.database.listMonitorEvents(taskId);
        const gate = await evaluateCompletionEvidence(request.cwd,events,{allowDocumentOnly:latestPhaseCheckpoint(events)?.phase.kind==="decision"});
        this.database.appendEvent(taskId,"completion_verification",gate,runId);
        const receipt = buildExecutionReceipt(taskId,runId,events,gate);
        this.database.appendEvent(taskId,"execution_receipt",receipt,runId);
        this.send({runId,taskId,type:"delivery_receipt",receipt,rendered:renderExecutionReceipt(receipt)});
        const usedThisRun = result.iterations ?? allowance.maxIterations;
        const remainingAfterRun = remainingTaskTurns === null ? null : Math.max(0, remainingTaskTurns - usedThisRun);
        const isBudgetBoundary = result.stopReason === "max_iterations" || result.stopReason === "tool_budget";
        const note = isBudgetBoundary
          ? remainingAfterRun === null
            ? `本阶段达到${result.stopReason === "tool_budget" ? "工具调用" : `${usedThisRun} 轮模型调用`}边界；进度、计划和记忆已保存。在本任务点击继续即可进入下一阶段，无需新建任务。`
            : remainingAfterRun > 0
            ? `本轮达到 ${usedThisRun} 轮安全边界；进度已保存，任务总预算还剩 ${remainingAfterRun} 轮。`
            : `任务累计模型轮次预算已用完；进度已保存。提高任务总预算后可以继续。`
          : "Agent 请求在当前检查点暂停；进度和计划均已保存。";
        this.database.appendEvent(taskId, isBudgetBoundary ? "run_budget_boundary" : "agent_checkpoint_pause", {
          stopReason: result.stopReason,
          usedThisRun,
          remainingTaskTurns: remainingAfterRun,
        }, runId);
        this.database.checkpointTask(taskId, {
          reason: "paused",
          conversationHistory: result.updatedHistory,
          usage: result.totalUsage,
          plan: currentPlan,
          note,
        }, runId);
        this.database.updateTaskStatus(taskId, "paused", { runId, note });
        this.sendTaskStatus(runId, taskId);
        this.send({
          runId,
          type: "paused",
          sessionId: session.id,
          taskId,
          reason: isBudgetBoundary ? "run_budget" : "checkpoint",
          message: note,
        });
        return;
      }

      const finalEvents = this.database.listMonitorEvents(taskId);

      // Durable state a later run can resume from without re-reading the whole
      // project. Every field is derived from persisted events, so a resumed run
      // inherits verified facts rather than the previous run's claims.
      const taskState = deriveTaskState(finalEvents, result.updatedHistory);
      this.database.appendEvent(taskId, "durable_task_state", taskState, runId);

      const completionGate = await evaluateCompletionEvidence(request.cwd, finalEvents);
      this.database.appendEvent(taskId, "completion_verification", completionGate, runId);

      // Reconcile what was declared against what the evidence proves, in
      // language the person reading it can act on without being an engineer.
      const receipt = buildExecutionReceipt(taskId,runId,finalEvents,completionGate);
      this.database.appendEvent(taskId, "execution_receipt", receipt, runId);
      this.send({
        runId,
        taskId,
        type: "delivery_receipt",
        receipt,
        rendered: renderExecutionReceipt(receipt),
      });

      if (completionGate.status === "failed") {
        this.database.checkpointTask(taskId, {
          reason: "failed",
          conversationHistory: result.updatedHistory,
          usage: result.totalUsage,
          plan: currentPlan,
          note: completionGate.summary,
        }, runId);
        this.database.updateTaskStatus(taskId, "failed", {
          runId,
          error: completionGate.summary,
          note: "模型执行结束，但独立完成门禁未通过。",
        });
        this.sendTaskStatus(runId, taskId);
        this.send({
          runId,
          type: "fatal",
          taskId,
          message: `${completionGate.summary}\n${completionGate.checks.filter(check=>check.status === "failed").map(check=>check.evidence).join("\n")}\n请修复后从检查点继续。`,
        });
        return;
      }

      this.database.checkpointTask(taskId, {
        reason: "completed",
        conversationHistory: result.updatedHistory,
        usage: result.totalUsage,
        plan: currentPlan,
      }, runId);
      this.database.updateTaskStatus(taskId, "completed", { runId });
      this.taskPermissionAllowances.delete(taskId);
      this.sendTaskStatus(runId, taskId);
      if (settings.memory.enabled) {
        await withModelAccounting({ model: settings.model, maxTokens: settings.maxTokens, systemPrompt: "", conversationHistory: [], tokenBudget: { warningThreshold: settings.tokenBudget.warningThreshold, hardLimit: settings.tokenBudget.hardLimit, priorTokens: consumedTokens(session.totalUsage) }, onEvent: (event) => { if (event.type === "model_call") accountSessionCall(session, event.record); this.database.appendEvent(taskId, `agent_${event.type}`, event, runId); } }, async () => {
          try {
        await extractAndSaveMemory(
          request.cwd,
          result.updatedHistory,
          provider,
          settings.model,
          true,
          session.id,
        ).catch((error) => {
          this.database.appendEvent(taskId, "memory_extraction_failed", error, runId);
        });
          } finally { await saveSession(session); }
        });
      }
      this.send({ runId, type: "complete", sessionId: session.id, taskId });
    } catch (err) {
      if (controller.signal.aborted) {
        const currentTask = this.database.getTask(taskId);
        this.database.updateTaskStatus(taskId, "paused", {
          runId,
          note: "任务在操作中暂停，可稍后继续",
        });
        this.sendTaskStatus(runId, taskId);
        if (currentTask?.sessionId) {
          this.send({
            runId,
            type: "paused",
            sessionId: currentTask.sessionId,
            taskId,
          });
        }
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.database.updateTaskStatus(taskId, "failed", { error: message, runId });
      this.database.appendEvent(taskId, "task_failure", err, runId);
      this.sendTaskStatus(runId, taskId);
      this.send({
        runId,
        type: "fatal",
        taskId,
        message,
      });
    } finally {
      const active = this.activeRuns.get(runId);
      if(active)active.acceptsSteering=false;
      if (
        streamSummary.textDeltaCount +
        streamSummary.thinkingDeltaCount +
        streamSummary.progressChunkCount +
        streamSummary.contextTrims > 0
      ) {
        this.database.appendEvent(taskId, "agent_stream_summary", streamSummary, runId);
      }
      // A run must not outlive its side effects. A dev server left holding a
      // port would make the next run fail with an address-already-in-use error
      // that has no visible cause.
      const stoppedServices = await stopAllServicesAndWait(request.cwd);
      const staleProfiles = reclaimStaleBrowserProfiles();
      if (stoppedServices > 0 || staleProfiles > 0) {
        this.database.appendEvent(taskId, "services_reclaimed", {
          services: stoppedServices,
          browserProfiles: staleProfiles,
        }, runId);
      }
      await mcp.disconnect();
    }
  }

  private async executeExternal(
    runId: string,
    taskId: string,
    request: AgentStartRequest,
    controller: AbortController,
    settings: AllyCodeSettings,
    engineId: Exclude<AgentEngineId, "native">,
    command: string,
  ): Promise<void> {
    const engine = getExternalAgentEngine(engineId);
    const boundSessionId = this.database.getTask(taskId)?.sessionId;
    const loaded = boundSessionId ? await loadSession(boundSessionId) : null;
    const session = loaded ?? createSession(request.cwd, `${engineId}:default`);
    if (boundSessionId && !loaded) throw new Error("外部引擎任务会话文件缺失，无法安全续接。");
    assertSessionWorkspace(session, request.cwd);
    if (request.resume && !session.externalEngine?.sessionId) throw new Error("该任务没有可恢复的外部引擎会话。");
    if (!session.title) session.title = deriveTitle(request.prompt);
    session.messages = [
      ...session.messages,
      { role: "user" as const, content: request.prompt },
    ];
    session.cwd = request.cwd;
    session.model = `${engineId}:default`;
    await saveSession(session);
    this.database.attachSession(taskId, session.id);
    this.database.checkpointTask(taskId, {
      reason: "initial",
      conversationHistory: session.messages,
      note: `${engine.descriptor.name} 任务已持久化`,
    }, runId);
    this.database.appendEvent(taskId, "agent_run_context", {
        build: BUILD_INFO,
      engine: engineId,
      engineContractVersion: engine.descriptor.contractVersion,
      engineMaturity: engine.descriptor.maturity,
      engineVersion: (await engine.health(command)).version,
      provider: "external-runtime",
      model: "由外部引擎配置决定",
      sandboxEnabled: true,
      skillCount: 0,
      mcpServerCount: 0,
    }, runId);

    const result = await engine.execute(command, {
      externalSessionId: session.externalEngine?.id === engineId && session.externalEngine.cwd === request.cwd ? session.externalEngine.sessionId : undefined,
      onSession: async (id) => { session.externalEngine = { id: engineId, sessionId: id, cwd: request.cwd }; await saveSession(session); },
      prompt: request.prompt,
      cwd: request.cwd,
      signal: controller.signal,
      onTrace: (eventType, payload) => {
        this.database.appendEvent(taskId, eventType, payload, runId);
      },
      onEvent: (event) => {
        if (!["text_delta", "thinking_delta", "tool_progress"].includes(event.type)) {
          this.database.appendEvent(taskId, `agent_${event.type}`, event, runId);
        }
        this.send({ runId, event });
      },
    });

    if (controller.signal.aborted) {
      this.database.checkpointTask(taskId, {
        reason: "paused",
        conversationHistory: session.messages,
        note: "外部引擎任务已暂停；当前适配器不保证可恢复",
      }, runId);
      this.database.updateTaskStatus(taskId, "paused", { runId });
      this.sendTaskStatus(runId, taskId);
      this.send({ runId, type: "paused", sessionId: session.id, taskId });
      return;
    }

    if (result.finalText) {
      session.messages.push({ role: "assistant", content: result.finalText });
    }
    await saveSession(session);
    this.database.checkpointTask(taskId, {
      reason: "completed",
      conversationHistory: session.messages,
      note: `外部会话 ${result.externalSessionId ?? "未返回"}`,
    }, runId);

    const completionGate = await evaluateCompletionEvidence(
      request.cwd,
      this.database.listMonitorEvents(taskId),
    );
    this.database.appendEvent(taskId, "completion_verification", completionGate, runId);
    if (completionGate.status === "failed") {
      this.database.updateTaskStatus(taskId, "failed", {
        runId,
        error: completionGate.summary,
        note: "外部引擎执行结束，但独立完成门禁未通过。",
      });
      this.sendTaskStatus(runId, taskId);
      this.send({
        runId,
        type: "fatal",
        taskId,
        message: `${completionGate.summary} 请检查外部引擎产物。`,
      });
      return;
    }
    this.database.updateTaskStatus(taskId, "completed", { runId });
    this.sendTaskStatus(runId, taskId);
    this.send({ runId, type: "complete", sessionId: session.id, taskId });
  }

  private askPermission(
    runId: string,
    taskId: string,
    request: PermissionRequest,
  ): Promise<PermissionDecision> {
    const requestId = randomUUID();
    this.database.updateTaskStatus(taskId, "waiting_permission", {
      runId,
      note: request.description,
    });
    this.database.appendEvent(taskId, "permission_requested", {
      requestId,
      request,
    }, runId);
    this.sendTaskStatus(runId, taskId);
    this.send({ runId, type: "permission", requestId, request });
    return new Promise((resolve) => {
      this.permissionResolvers.set(requestId, { runId, taskId, resolve });
    });
  }

  private createTaskPermissionCache(taskId: string): Set<string> {
    const cache = new Set<string>();
    this.taskPermissionAllowances.set(taskId, cache);
    return cache;
  }

  private sendTaskStatus(runId: string, taskId: string): void {
    const task = this.database.getTask(taskId);
    if (task) this.send({ runId, type: "task_status", task: this.toTaskSummary(task) });
  }

  private toTaskSummary(task: TaskRecord): TaskSummary {
    const project = this.database.getProject(task.projectId);
    return {
      id: task.id,
      projectId: task.projectId,
      sessionId: task.sessionId,
      title: task.title,
      goal: task.goal,
      status: task.status,
      cwd: project?.primaryPath ?? "",
      updatedAt: task.updatedAt,
      createdAt: task.createdAt,
      lastError: task.lastError,
      resumable: ["paused", "failed"].includes(task.status) && Boolean(task.checkpoint),
      plan: task.checkpoint?.plan,
    };
  }

  private send(event: DesktopAgentEvent): void {
    // Private provider reasoning stays in continuation storage; UI gets a progress signal only.
    if("event" in event && event.event.type==="thinking_delta")event={...event,event:{type:"thinking_delta",delta:""}};
    const target = this.webContents();
    if (target && !target.isDestroyed()) target.send("agent:event", event);
  }
}
