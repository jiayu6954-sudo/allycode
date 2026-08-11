import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import { runAgentLoop } from "../src/agent/loop.js";
import { runResearchLoop } from "../src/agent/research-loop.js";
import { buildSystemPrompt } from "../src/agent/system-prompt.js";
import { loadSettings } from "../src/config/settings.js";
import { loadClaudeMd } from "../src/memory/claude-md.js";
import { extractAndSaveMemory } from "../src/memory/long-term.js";
import {
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

interface ActiveRun {
  controller: AbortController;
  taskId: string;
}

interface PendingPermission {
  runId: string;
  taskId: string;
  resolve: (decision: PermissionDecision) => void;
}

export class DesktopAgentService {
  private activeRuns = new Map<string, ActiveRun>();
  private permissionResolvers = new Map<string, PendingPermission>();
  private readonly database = getAgentDatabase();

  constructor(
    private webContents: () => WebContents | null,
    private settingsLoader: () => Promise<AllyCodeSettings> = loadSettings,
  ) {
    this.database.recoverInterruptedTasks();
  }

  start(request: AgentStartRequest): { runId: string; taskId: string } {
    const runId = randomUUID();
    const controller = new AbortController();
    const project = this.database.resolveProject(request.cwd);
    const requestedTask = request.taskId
      ? this.database.getTask(request.taskId)
      : null;
    if (requestedTask && requestedTask.projectId !== project.id) {
      throw new Error("Task does not belong to the selected project.");
    }
    const task = requestedTask ?? this.database.createTask({
      projectId: project.id,
      title: deriveTitle(request.prompt || "继续未完成任务"),
      goal: request.prompt || "继续未完成任务",
      sessionId: request.sessionId,
    });
    this.database.updateTaskStatus(task.id, "running", { runId });
    this.activeRuns.set(runId, { controller, taskId: task.id });
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
      prompt: "继续上次中断的任务。从已保存的检查点继续，不要重复已经完成的操作。",
      cwd: project.primaryPath,
      sessionId: task.sessionId,
      taskId,
      resume: true,
    });
  }

  private async execute(
    runId: string,
    taskId: string,
    request: AgentStartRequest,
    controller: AbortController,
  ): Promise<void> {
    const mcp = new MCPRegistry();
    try {
      const settings = await this.settingsLoader();
      const provider = createProvider(settings);
      const task = this.database.getTask(taskId);
      if (!task) throw new Error("Task state disappeared before execution.");
      const loaded = task.sessionId || request.sessionId
        ? await loadSession(task.sessionId ?? request.sessionId!)
        : null;
      const session = loaded ?? createSession(request.cwd, settings.model);
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

      await mcp.connect(settings.mcpServers);
      const sandbox = settings.sandbox.enabled
        ? new SandboxManager(settings.sandbox, { workspaceId: taskId })
        : undefined;
      const permissionManager = new PermissionManager(
        settings,
        (permissionRequest) => this.askPermission(runId, taskId, permissionRequest),
        Boolean(sandbox),
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
      const projectContext = await loadClaudeMd(
        request.cwd,
        settings.context.claudeMdPaths,
      );
      const systemPrompt = await buildSystemPrompt(
        request.cwd,
        projectContext,
        settings,
        null,
        request.prompt,
      );
      const result = await runAgentLoop(
        provider,
        {
          model: settings.model,
          maxTokens: settings.maxTokens,
          systemPrompt,
          conversationHistory,
          onEvent: (event) => {
            this.database.appendEvent(taskId, `agent_${event.type}`, event, runId);
            this.send({ runId, event });
          },
          onHistoryChange: async (history) => {
            session.messages = history;
            await saveSession(session);
            this.database.checkpointTask(taskId, {
              reason: "iteration",
              conversationHistory: history,
              note: "Agent 迭代完成，已保存可恢复状态",
            }, runId);
          },
          signal: controller.signal,
          tokenBudget: {
            warningThreshold: settings.tokenBudget.warningThreshold,
            hardLimit: settings.tokenBudget.hardLimit,
            priorTokens:
              session.totalUsage.inputTokens + session.totalUsage.outputTokens,
          },
        },
        tools,
        permissionManager,
      );

      session.messages = result.updatedHistory;
      session.model = settings.model;
      session.cwd = request.cwd;
      session.totalUsage.inputTokens += result.totalUsage.inputTokens;
      session.totalUsage.outputTokens += result.totalUsage.outputTokens;
      session.totalUsage.cacheReadTokens += result.totalUsage.cacheReadTokens;
      session.totalUsage.cacheWriteTokens += result.totalUsage.cacheWriteTokens;
      session.totalUsage.estimatedCostUsd += result.totalUsage.estimatedCostUsd;
      await saveSession(session);
      this.database.attachSession(taskId, session.id);

      if (controller.signal.aborted) {
        this.database.checkpointTask(taskId, {
          reason: "paused",
          conversationHistory: result.updatedHistory,
          usage: result.totalUsage,
          note: "任务已暂停，可从此检查点继续",
        }, runId);
        this.database.updateTaskStatus(taskId, "paused", { runId });
        this.sendTaskStatus(runId, taskId);
        this.send({ runId, type: "paused", sessionId: session.id, taskId });
        return;
      }

      this.database.checkpointTask(taskId, {
        reason: "completed",
        conversationHistory: result.updatedHistory,
        usage: result.totalUsage,
      }, runId);
      this.database.updateTaskStatus(taskId, "completed", { runId });
      this.sendTaskStatus(runId, taskId);
      if (settings.memory.enabled) {
        await extractAndSaveMemory(
          request.cwd,
          result.updatedHistory,
          provider,
          settings.model,
          true,
        ).catch((error) => {
          this.database.appendEvent(taskId, "memory_extraction_failed", error, runId);
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
      await mcp.disconnect();
    }
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
      resumable: task.status === "paused" && Boolean(task.checkpoint),
    };
  }

  private send(event: DesktopAgentEvent): void {
    const target = this.webContents();
    if (target && !target.isDestroyed()) target.send("agent:event", event);
  }
}
