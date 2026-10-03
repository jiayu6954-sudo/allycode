import type { AgentLoopOptions, AgentLoopResult, TokenUsage, ConversationMessage } from "../types/agent.js";
import type { NormalizedBlock, NormalizedMessage } from "../providers/interface.js";
import type { AIProvider } from "../providers/index.js";
import type { ToolName } from "../types/tools.js";
import { StreamHandler } from "./stream.js";
import { hydrateContinuation } from "../storage/continuation-state.js";
import { getRegisteredModelCapabilities } from "../providers/model-catalog.js";
import { applyHistoryBudget, estimateTokens } from "./history-budget.js";
import {
  advanceCompaction,
  createCompactionState,
  renderCompaction,
  validateCompactionState,
} from "./context-compaction.js";
import { ToolRegistry } from "../tools/registry.js";
import { PermissionManager } from "../permissions/manager.js";
import { SessionStats } from "../utils/stats.js";
import { meteredProvider, withModelAccounting } from "../providers/model-gateway.js";
import { logger } from "../utils/logger.js";
import { PhaseCheckpointSchema, renderPhaseCheckpoint } from "./phase-workflow.js";

const DEFAULT_MAX_ITERATIONS = 200;
// I026: Pattern the AI uses to signal a checkpoint pause
const CHECKPOINT_RE = /\[\[CHECKPOINT(?::\s*(.*?))?\]\]/s;

/**
 * Innovation 1: Parallel Tool Execution
 *
 * 原版（含 Claude Code）的工具执行策略：串行
 *   ask permission(A) → execute(A) → ask permission(B) → execute(B)
 *
 * devai 创新策略：权限串行收集，执行并行化
 *   ask permission(A) → ask permission(B)   [串行，UX清晰]
 *         ↓                   ↓
 *   execute(A)         execute(B)            [并行，速度翻倍]
 *         ↓                   ↓
 *         └──────── allSettled ─────────────→ 收集结果
 */
export function runAgentLoop(provider: AIProvider, options: AgentLoopOptions, tools: ToolRegistry, permissions: PermissionManager, stats?: SessionStats): Promise<AgentLoopResult> {
  return withModelAccounting(options, (totalUsage) => runAgentLoopImpl(meteredProvider(provider), options, tools, permissions, stats, totalUsage));
}

async function runAgentLoopImpl(
  provider: AIProvider,
  options: AgentLoopOptions,
  tools: ToolRegistry,
  permissions: PermissionManager,
  stats: SessionStats | undefined,
  totalUsage: TokenUsage,
): Promise<AgentLoopResult> {
  const messages = hydrateContinuation(options.conversationHistory);

  let iterations = 0;
  let waitingAfterTool = false;
  let lastMessage: NormalizedMessage | undefined;
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  // P016: guard against infinite retry on unavailable tools (e.g. web_search blocked by GFW)
  let consecutiveToolErrors = 0;
  let currentRunToolCalls = 0;
  // Narrative + factual bridge for whatever the budget removes. Carried across
  // turns so a summary is written once, not regenerated on every request.
  const compaction = options.compactionState ?? createCompactionState();
  validateCompactionState(compaction, messages);
  const CONSECUTIVE_ERROR_LIMIT = 5;
  let hasPlan = false;
  let currentPlan = options.initialPlan ?? [];
  let closingAttempts = 0;
  let planningAttempts = 0;
  const pendingSteering = () => options.readSteering?.() ?? [];
  const applySteering = async () => {
    const pending = pendingSteering();
    if (!pending.length) return false;
    const added = pending.filter(item => !messages.some(message => message.steeringId === item.id));
    for (const item of added) messages.push({role:"user",content:item.text,steeringId:item.id});
    await notifyHistoryChange(options, messages);
    await options.onSteeringApplied?.(pending);
    for (const item of added) options.onEvent({type:"user_steering",...item});
    hasPlan = false;
    planningAttempts = 0;
    return true;
  };

  while (iterations < maxIterations) {
    iterations++;
    await applySteering();
    const planning = Boolean(options.requirePlan && !hasPlan);
    if (planning && ++planningAttempts > 3) throw new Error("模型未能生成有效工作计划，已暂停执行。请检查模型配置后继续。");

    if (options.signal?.aborted) {
      options.onEvent({ type: "status", phase: "completed", iteration: iterations, stopReason: "aborted" });
      options.onEvent({ type: "done", stopReason: "aborted" });
      return abortedResult(messages, totalUsage);
    }

    // ── Innovation 8: token budget hard-limit check ───────────────────────
    if (options.tokenBudget?.hardLimit !== undefined) {
      const consumed =
        (options.tokenBudget.priorTokens ?? 0) +
        totalUsage.inputTokens + totalUsage.cacheReadTokens + totalUsage.cacheWriteTokens +
        totalUsage.outputTokens + (totalUsage.unknownReservedTokens ?? 0);
      if (consumed >= options.tokenBudget.hardLimit) {
        const err = new Error(
          `Token budget exceeded: ${consumed.toLocaleString()} / ${options.tokenBudget.hardLimit.toLocaleString()} tokens used. ` +
          `Raise tokenBudget.hardLimit in settings or start a new session.`
        );
        options.onEvent({ type: "error", error: err });
        throw err;
      }
    }

    logger.debug("loop.iteration", { iteration: iterations, messages: messages.length });
    options.onEvent({
      type: "status",
      phase: waitingAfterTool ? "waiting_model_after_tool" : "waiting_model",
      iteration: iterations,
    });
    waitingAfterTool = false;

    // ── 1. 发起流式请求 ──────────────────────────────────────────────────
    // As the run approaches its deterministic boundary, steer the model to
    // close a runnable vertical slice and leave truthful plan/test evidence.
    // This is attached to the system prompt instead of conversation history so
    // it cannot split an assistant tool-use / user tool-result transaction.
    const remainingIterations = maxIterations - iterations + 1;
    const budgetGuidance = remainingIterations <= 8
      ? `\n\n# Current run budget\nOnly ${remainingIterations} model turn${remainingIterations === 1 ? "" : "s"} remain in this run. ` +
        "Immediately update the working plan to match verified progress. Stop opening new broad workstreams or rewriting completed analysis; " +
        "prioritize the user's requested deliverable format and its focused verification. For reports, finish generating the document, reopen and verify it; do not start more exploratory analysis. " +
        "Do not claim completion when required checks fail. Any unfinished work will be checkpointed for the next run."
      : "";
    // Every turn resends the whole transcript, so an unbounded history bills
    // O(n²). The model receives a DERIVED working context sized to a budget —
    // `messages` remains the canonical transcript and is never shortened by
    // it. Trimming the canonical array would trade the user's durable record
    // for tokens: session export, resume and memory extraction all read it.
    // First pass discovers what WOULD be dropped, so the span can be
    // summarised before it disappears rather than after.
    const fixedTokens = estimateTokens(options.systemPrompt + budgetGuidance) + estimateTokens(JSON.stringify(tools.getDefinitions())) + options.maxTokens + 512;
    const contextWindow = getRegisteredModelCapabilities(provider.providerName, options.model)?.capabilities.contextWindow ?? 128_000;
    const historyOptions = { ...options.historyBudget, maxContextTokens: Math.min(options.historyBudget?.maxContextTokens ?? 60_000, contextWindow - fixedTokens) };
    if (historyOptions.maxContextTokens <= 0) throw new Error("上下文预算不足：系统提示、工具和输出预留超过模型窗口。");
    const probe = applyHistoryBudget(messages, historyOptions);
    let budgeted = probe;
    if (probe.droppedRange && options.compactContext !== false) {
      await advanceCompaction(
        compaction, messages, probe.droppedRange.end, provider, options.model, options.signal,
      );
      await options.onCompactionChange?.(compaction);
      const summaryMessages = renderCompaction(compaction, probe.droppedMessages);
      if (summaryMessages.length > 0) {
        budgeted = applyHistoryBudget(messages, {
          ...historyOptions,
          summaryMessages,
        });
      }
    }
    const workingContext = budgeted.messages;
    if (budgeted.after < budgeted.before) {
      options.onEvent({
        type: "context_budget",
        beforeTokens: budgeted.before,
        afterTokens: budgeted.after,
        agedResults: budgeted.agedResults,
        droppedMessages: budgeted.droppedMessages,
        canonicalMessages: messages.length,
        workingMessages: workingContext.length,
        summarised: compaction.narratives.length > 0,
        summaryModelCalls: compaction.modelCalls,
      });
    }

    let streamHandle;
    try {
      streamHandle = provider.stream({
        model: options.model,
        purpose: options.modelCallPurpose ?? "main",
        maxTokens: options.maxTokens,
        systemPrompt: options.systemPrompt + budgetGuidance + (planning ? "\n当前步骤：先调用 plan_update 发布或更新中文任务清单。当前请求仅允许计划工具，完成有效计划后才继续工程操作。" : ""),
        messages: workingContext,
        tools: planning ? tools.getDefinitions().filter(tool=>tool.name === "plan_update") : tools.getDefinitions(),
        signal: options.signal,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error("loop.stream_create.error", err);
      options.onEvent({ type: "error", error });
      throw error;
    }

    // ── 2. 处理流式 delta ────────────────────────────────────────────────
    let receivedFirstDelta = false;
    const handler = new StreamHandler((event) => {
      if (!receivedFirstDelta &&
          (event.type === "text_delta" || event.type === "thinking_delta")) {
        receivedFirstDelta = true;
        options.onEvent({
          type: "stream_signal",
          signal: event.type === "text_delta" ? "text" : "thinking",
          iteration: iterations,
        });
        options.onEvent({ type: "status", phase: "streaming", iteration: iterations });
      }
      options.onEvent(event);
    });
    await handler.process(streamHandle, options.signal);

    if (options.signal?.aborted) {
      options.onEvent({ type: "status", phase: "completed", iteration: iterations, stopReason: "aborted" });
      options.onEvent({ type: "done", stopReason: "aborted" });
      return abortedResult(messages, totalUsage);
    }

    // ── 3. 获取完整消息 ──────────────────────────────────────────────────
    let message;
    try {
      message = await streamHandle.finalMessage();
      lastMessage = message;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error("loop.finalMessage.error", err);
      options.onEvent({ type: "error", error });
      throw error;
    }

    // ── 4. 累计 token 用量 ───────────────────────────────────────────────
    const usage = message.usage;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;

    stats?.updateUsage({
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
    });

    // ── 5. 追加 assistant 完整 content（转换为 Anthropic 历史格式）────────
    messages.push(normalizedToHistory(message.content, message.providerState));
    // The provider owns continuation-state lifetime, including final replies.
    enforceReasoningRetention(messages);
    // A tool-use assistant turn and its tool-result user turn form one
    // protocol transaction. Persist them atomically so a process crash cannot
    // leave an orphan tool call that providers reject when the task resumes.
    if (message.stop_reason !== "tool_use") {
      await notifyHistoryChange(options, messages);
    }

    // ── 6. 检查 stop_reason ──────────────────────────────────────────────
    if (message.stop_reason === "end_turn" || message.stop_reason === "stop_sequence") {
      if (await applySteering()) continue;
      if (planning) {
        messages.push({role:"user",content:"请先调用 plan_update 给出结构化中文步骤，再开始工作。仅文字描述计划尚未建立任务进度。"});
        await notifyHistoryChange(options,messages);
        continue;
      }
      const unfinished = currentPlan.some(item=>item.status !== "completed");
      const explicitCheckpoint = message.content.some(block=>block.type === "text" && CHECKPOINT_RE.test(block.text));
      if (options.requirePlan && unfinished && !explicitCheckpoint && closingAttempts++ === 0) {
        messages.push({role:"user",content:"系统进度核对：计划仍有未完成步骤。请依据证据调用 plan_update 更新；验证之后更新计划不会使证据失效。若确实受阻或需要下一阶段，请保留未完成状态并用 phase_checkpoint 或 [[CHECKPOINT: 具体原因]] 保存续接，不要为了收尾虚假打勾，也不要仅为更新计划重跑测试。"});
        await notifyHistoryChange(options,messages);
        continue;
      }
      // I026: scan text content for [[CHECKPOINT: reason]] markers
      // When found: strip the marker, emit checkpoint event, pause loop for user review
      let checkpointMessage: string | null = options.requirePlan && unfinished ? "计划仍有未完成事项，已保存进度，待核对后继续。" : null;
      for (const block of message.content) {
        if (block.type === "text") {
          const match = CHECKPOINT_RE.exec(block.text);
          if (match) {
            checkpointMessage = (match[1] ?? "Phase complete").trim();
            // Strip the marker from the visible text
            block.text = block.text.replace(CHECKPOINT_RE, "").trim();
            break;
          }
        }
      }
      if (checkpointMessage !== null) {
        options.onEvent({ type: "checkpoint", message: checkpointMessage });
        options.onEvent({ type: "status", phase: "completed", iteration: iterations, stopReason: "checkpoint" });
        options.onEvent({ type: "done", stopReason: "checkpoint" });
      } else {
        options.onEvent({ type: "status", phase: "completed", iteration: iterations, stopReason: message.stop_reason });
        options.onEvent({ type: "done", stopReason: message.stop_reason });
      }
      return {
        finalMessage: message,
        updatedHistory: messages,
        totalUsage,
        stopReason: checkpointMessage !== null ? "checkpoint" : message.stop_reason,
        iterations,
      };
    }

    if (message.stop_reason === "max_tokens") {
      // Auto-continue — but ONLY if the assistant message has no tool_calls.
      // When max_tokens hits mid-tool_call JSON the content contains tool_use blocks
      // with potentially malformed input. Injecting "continue" without tool_result
      // responses violates OAI message ordering → DeepSeek/OpenAI 400.
      // In that case: inject dummy error tool_results first, then the continue prompt.
      const pendingToolUses = message.content.filter((b) => b.type === "tool_use") as
        Array<{ type: "tool_use"; id: string; name: string; input: unknown }>;

      logger.info("loop.max_tokens_continue", {
        iteration: iterations,
        maxTokens: options.maxTokens,
        pendingTools: pendingToolUses.length,
      });
      options.onEvent({ type: "text_delta", delta: "\n[本次输出达到长度限制，正在继续…]\n" });

      if (pendingToolUses.length > 0) {
        // Inject dummy tool_results so the message sequence stays valid
        const dummyResults = pendingToolUses.map((b) => ({
          type: "tool_result" as const,
          tool_use_id: b.id,
          content: "[truncated: output limit reached mid-tool]",
          is_error: true,
        }));
        messages.push({ role: "user", content: dummyResults });

        // Tool-specific continue: tell the model to resume writing the file,
        // NOT to reconsider its approach or offer a simplified version.
        const toolNames = pendingToolUses.map((b) => b.name).join(", ");
        const isFileWrite = pendingToolUses.some(
          (b) => b.name === "file_write" || b.name === "file_edit"
        );
        const continueMsg = isFileWrite
          ? "The file write was cut off due to output length. Do NOT offer a simplified version. " +
            "Write the NEXT section of the document directly using file_write (append mode or a new section file). " +
            "Continue the full content without repeating what was already written."
          : `The tool call (${toolNames}) was cut off. Resume the task from where you left off.`;

        messages.push({ role: "user", content: continueMsg });
      } else {
        messages.push({
          role: "user",
          content: "You were cut off due to the output length limit. Continue exactly from where you left off, without repeating anything.",
        });
      }
      await notifyHistoryChange(options, messages);
      continue;
    }

    // ── 7. 处理 tool_use（Innovation 1：并行执行）────────────────────────
    if (message.stop_reason === "tool_use") {
      const toolUseBlocks = message.content.filter(
        (b): b is Extract<NormalizedBlock, { type: "tool_use" }> => b.type === "tool_use"
      );
      if (toolUseBlocks.some(block=>block.name === "phase_checkpoint") && toolUseBlocks.length !== 1) {
        messages.push({role:"user",content:toolUseBlocks.map(block=>({type:"tool_result" as const,tool_use_id:block.id,is_error:true,content:"阶段确认必须单独调用。本组工具未执行；请先完成计划和文档，再单独调用 phase_checkpoint 等待用户。"}))});
        await notifyHistoryChange(options,messages);
        continue;
      }
      if (!receivedFirstDelta && toolUseBlocks.length > 0) {
        options.onEvent({ type: "stream_signal", signal: "tool", iteration: iterations });
      }
      if (pendingSteering().length || (planning && toolUseBlocks.some(block=>block.name !== "plan_update"))) {
        messages.push({role:"user",content:toolUseBlocks.map(block=>({type:"tool_result" as const,tool_use_id:block.id,is_error:true,content:pendingSteering().length ? "用户有新的补充要求，本组工具尚未执行；请依据最新要求更新计划。" : "尚未发布工作计划。本工具未执行，请先单独调用 plan_update。"}))});
        await notifyHistoryChange(options,messages);
        continue;
      }

      if (
        options.toolBudget &&
        options.toolBudget.priorToolCalls + currentRunToolCalls + toolUseBlocks.length >
          options.toolBudget.hardLimit
      ) {
        messages.push({ role: "user", content: toolUseBlocks.map((block) => ({
          type: "tool_result" as const, tool_use_id: block.id,
          content: "本阶段工具预算已达边界，本组工具未执行。进度已保存，续接后请检查并继续。", is_error: true,
        })) });
        await notifyHistoryChange(options, messages);
        options.onEvent({type:"checkpoint",message:"本阶段工具预算已达边界，可在原任务继续。"});
        options.onEvent({type:"done",stopReason:"tool_budget"});
        return {finalMessage:message,updatedHistory:messages,totalUsage,stopReason:"tool_budget",iterations};
      }
      currentRunToolCalls += toolUseBlocks.length;

      const { results: toolResults, allDenied } = await executeToolsWithParallelism(
        toolUseBlocks,
        tools,
        permissions,
        options.onEvent,
        stats,
        iterations,
        options.signal,
        () => pendingSteering().length > 0,
      );

      for (const block of toolUseBlocks) {
        if (block.name !== "plan_update" || !toolResults.some(result=>result.tool_use_id===block.id && !result.is_error)) continue;
        const input = block.input as import("../types/tools.js").PlanUpdateInput;
        options.onEvent({
          type: "plan_update",
          items: input.items,
          explanation: input.explanation,
        });
        hasPlan = true;
        currentPlan = input.items;
        planningAttempts = 0;
      }

      if (pendingSteering().length && !toolUseBlocks.some(block=>block.name === "phase_checkpoint" && toolResults.some(result=>result.tool_use_id===block.id && !result.is_error))) {
        messages.push({role:"user",content:toolResults});
        await notifyHistoryChange(options,messages);
        continue;
      }

      // If the user denied ALL tools, stop the loop immediately.
      // Without this the agent receives "Permission denied. Try a different approach"
      // and keeps attempting alternative approaches — user sees commands still running.
      // NOTE: assistant message already pushed at line 136 (normalizedToHistory).
      // Do NOT push again here — that would create duplicate consecutive assistant
      // messages which causes API errors and "no output" symptoms.
      if (allDenied) {
        messages.push({ role: "user", content: toolResults });
        await notifyHistoryChange(options, messages);
        options.onEvent({ type: "status", phase: "completed", iteration: iterations, stopReason: "denied" });
        options.onEvent({ type: "done", stopReason: "denied" });
        return { finalMessage: message, updatedHistory: messages, totalUsage, stopReason: "denied", iterations };
      }

      // Persist the whole transaction even when this round causes a terminal error.
      messages.push({ role: "user", content: toolResults });
      await notifyHistoryChange(options, messages);

      const phaseCall = toolUseBlocks.find(block=>block.name === "phase_checkpoint" && toolResults.some(result=>result.tool_use_id === block.id && !result.is_error));
      if (phaseCall) {
        const phase = PhaseCheckpointSchema.parse(phaseCall.input);
        const text = renderPhaseCheckpoint(phase);
        messages.push({role:"assistant",content:text});
        await notifyHistoryChange(options,messages);
        options.onEvent({type:"text_delta",delta:`\n${text}`});
        options.onEvent({type:"checkpoint",message:phase.title});
        options.onEvent({type:"done",stopReason:"checkpoint"});
        return {finalMessage:message,updatedHistory:messages,totalUsage,stopReason:"checkpoint",iterations};
      }

      // P016: detect consecutive all-error tool rounds (e.g. web_search blocked by GFW)
      const allErrors = toolResults.every(
        (r): r is Extract<typeof r, { is_error?: boolean }> =>
          "is_error" in r && r.is_error === true
      );
      if (allErrors) {
        consecutiveToolErrors++;
        if (consecutiveToolErrors >= CONSECUTIVE_ERROR_LIMIT) {
          const err = new Error(
            `Agent loop aborted: ${consecutiveToolErrors} consecutive tool-error rounds. ` +
            `This usually means a required service (e.g. web_search) is unavailable. ` +
            `Check your API keys or network connectivity.`
          );
          options.onEvent({ type: "error", error: err });
          throw err;
        }
      } else {
        consecutiveToolErrors = 0;
      }

      waitingAfterTool = true;
      options.onEvent({ type: "status", phase: "waiting_model_after_tool", iteration: iterations });
      continue;
    }

    // 未知 stop_reason
    logger.warn("loop.unexpected_stop_reason", { stopReason: message.stop_reason });
    options.onEvent({ type: "status", phase: "completed", iteration: iterations, stopReason: message.stop_reason ?? "unknown" });
    options.onEvent({ type: "done", stopReason: message.stop_reason ?? "unknown" });
    return {
      finalMessage: message,
      updatedHistory: messages,
      totalUsage,
      stopReason: message.stop_reason ?? "unknown",
      iterations,
    };
  }

  // A per-run iteration cap is a cost/safety checkpoint, not an execution
  // failure. Canonical history has already been persisted after the last tool
  // transaction, so the desktop service can expose a one-click continuation.
  options.onEvent({ type: "status", phase: "completed", iteration: iterations, stopReason: "max_iterations" });
  options.onEvent({ type: "done", stopReason: "max_iterations" });
  return {
    finalMessage: lastMessage ?? emptyFinalMessage(),
    updatedHistory: messages,
    totalUsage,
    stopReason: "max_iterations",
    iterations,
  };
}

/** Continuation lifetime is provider-owned. Kept for API compatibility. */
export function enforceReasoningRetention(_messages: ConversationMessage[]): number {
  return 0;
}

async function notifyHistoryChange(
  options: AgentLoopOptions,
  messages: ConversationMessage[],
): Promise<void> {
  await options.onHistoryChange?.([...messages]);
}

function abortedResult(
  messages: ConversationMessage[],
  totalUsage: TokenUsage,
): AgentLoopResult {
  return {
    finalMessage: emptyFinalMessage(),
    updatedHistory: messages,
    totalUsage,
    stopReason: "aborted",
  };
}

function emptyFinalMessage(): NormalizedMessage {
  return {
    stop_reason: "end_turn",
    content: [],
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Convert NormalizedBlock[] → Anthropic-compatible assistant message for history.
 * The history format is always Anthropic-style internally (works as-is for
 * Anthropic provider; OpenAI provider converts it back in toOAIMessages()).
 */
export function normalizedToHistory(
  content: NormalizedBlock[],
  providerState?: import("../providers/interface.js").ProviderTurnState,
): ConversationMessage {
  return {
    role: "assistant",
    ...(providerState ? { providerState } : {}),
    content: content.map((block) => {
      if (block.type === "text") {
        return { type: "text" as const, text: block.text };
      }
      return {
        type: "tool_use" as const,
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      };
    }),
  };
}

// ── Innovation 1: Two-phase parallel execution ───────────────────────────────

type ToolUseBlock = Extract<NormalizedBlock, { type: "tool_use" }>;
type ToolResultParam = { type: "tool_result"; tool_use_id: string; content: string; is_error: boolean };

async function executeToolsWithParallelism(
  toolUseBlocks: ToolUseBlock[],
  tools: ToolRegistry,
  permissions: PermissionManager,
  onEvent: AgentLoopOptions["onEvent"],
  stats: SessionStats | undefined,
  iteration: number,
  signal?: AbortSignal,
  shouldYield: () => boolean = () => false,
): Promise<{ results: ToolResultParam[]; allDenied: boolean }> {

  // Phase 1: serial permission collection
  type DecisionRecord = { toolBlock: ToolUseBlock; decision: "allow" | "deny" };
  const decisions: DecisionRecord[] = [];

  for (const toolBlock of toolUseBlocks) {
    if (signal?.aborted) break;
    if (shouldYield()) { decisions.push({toolBlock,decision:"deny"}); continue; }

    const toolName = toolBlock.name as ToolName;
    onEvent({ type: "tool_pending", toolName, toolId: toolBlock.id, input: toolBlock.input });

    let decision: "allow" | "deny";
    try {
      const raw = await permissions.request(
        toolName,
        toolBlock.input as Parameters<typeof permissions.request>[1]
      );
      decision = raw === "allow" || raw === "allow-session" ? "allow" : "deny";
    } catch {
      decision = "deny";
    }

    if (decision === "deny") {
      onEvent({ type: "tool_denied", toolId: toolBlock.id, toolName });
    }

    decisions.push({ toolBlock, decision });
  }

  // Unknown tools, shell, service changes and writes are serial barriers.
  // Only consecutive independent read operations share a batch.
  const readOnly = new Set(["file_read", "glob", "grep", "web_fetch", "web_search", "session_search", "evidence_read"]);
  const results: ToolResultParam[] = [];
  const execute = async ({ toolBlock, decision }: DecisionRecord): Promise<ToolResultParam> => {
    if (shouldYield()) return {type:"tool_result",tool_use_id:toolBlock.id,content:"用户补充要求已到，本工具尚未执行，等待重新规划。",is_error:true};
    if (decision === "deny" || signal?.aborted) return { type: "tool_result", tool_use_id: toolBlock.id, content: "Permission denied or execution cancelled.", is_error: true };
    try { return await executeSingleTool(toolBlock, tools, onEvent, stats, iteration, signal); }
    catch (error) { return { type: "tool_result", tool_use_id: toolBlock.id, content: String(error), is_error: true }; }
  };
  for (let index = 0; index < decisions.length;) {
    const batch: DecisionRecord[] = [decisions[index++]!];
    if (readOnly.has(batch[0]!.toolBlock.name)) {
      while (index < decisions.length && readOnly.has(decisions[index]!.toolBlock.name)) batch.push(decisions[index++]!);
    }
    results.push(...await Promise.all(batch.map(execute)));
  }

  const allDenied = decisions.length > 0 && decisions.every((d) => d.decision === "deny");
  return { results, allDenied };
}

async function executeSingleTool(
  toolBlock: ToolUseBlock,
  tools: ToolRegistry,
  onEvent: AgentLoopOptions["onEvent"],
  stats: SessionStats | undefined,
  iteration: number,
  signal?: AbortSignal
): Promise<ToolResultParam> {
  const toolName = toolBlock.name as ToolName;
  onEvent({
    type: "status",
    phase: "tool_running",
    iteration,
    toolName,
    toolId: toolBlock.id,
  });
  onEvent({ type: "tool_start", toolName, toolId: toolBlock.id, input: toolBlock.input });

  try {
    const result = await tools.execute(toolName, toolBlock.input, {
      signal,
      onProgress: (chunk: string) => {
        onEvent({ type: "tool_progress", toolId: toolBlock.id, chunk });
      },
    });
    stats?.recordToolCall(toolName, result.fromCache, result.isError);

    onEvent({
      type: "tool_result",
      toolId: toolBlock.id,
      toolName,
      content: result.content,
      isError: result.isError,
      metadata: result.metadata,
    });

    return {
      type: "tool_result",
      tool_use_id: toolBlock.id,
      content: result.content,
      is_error: result.isError,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`tool.${toolName}.unhandled`, err);
    stats?.recordToolCall(toolName, false, true);

    onEvent({
      type: "tool_result",
      toolId: toolBlock.id,
      toolName,
      content: `Unexpected error: ${msg}`,
      isError: true,
    });

    return {
      type: "tool_result",
      tool_use_id: toolBlock.id,
      content: `Tool execution failed: ${msg}`,
      is_error: true,
    };
  }
}
