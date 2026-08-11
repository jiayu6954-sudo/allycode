import type { AgentLoopOptions, AgentLoopResult, TokenUsage, ConversationMessage } from "../types/agent.js";
import type { NormalizedBlock } from "../providers/interface.js";
import type { AIProvider } from "../providers/index.js";
import type { ToolName } from "../types/tools.js";
import { StreamHandler } from "./stream.js";
import { ToolRegistry } from "../tools/registry.js";
import { PermissionManager } from "../permissions/manager.js";
import { SessionStats } from "../utils/stats.js";
import { calculateCost } from "../utils/cost-calculator.js";
import { logger } from "../utils/logger.js";

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
export async function runAgentLoop(
  provider: AIProvider,
  options: AgentLoopOptions,
  tools: ToolRegistry,
  permissions: PermissionManager,
  stats?: SessionStats
): Promise<AgentLoopResult> {
  const messages = [...options.conversationHistory];
  const totalUsage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCostUsd: 0,
  };

  let iterations = 0;
  let waitingAfterTool = false;
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  // P016: guard against infinite retry on unavailable tools (e.g. web_search blocked by GFW)
  let consecutiveToolErrors = 0;
  const CONSECUTIVE_ERROR_LIMIT = 5;

  while (iterations < maxIterations) {
    iterations++;

    if (options.signal?.aborted) {
      options.onEvent({ type: "status", phase: "completed", iteration: iterations, stopReason: "aborted" });
      options.onEvent({ type: "done", stopReason: "aborted" });
      return abortedResult(messages, totalUsage);
    }

    // ── Innovation 8: token budget hard-limit check ───────────────────────
    if (options.tokenBudget?.hardLimit !== undefined) {
      const consumed =
        (options.tokenBudget.priorTokens ?? 0) +
        totalUsage.inputTokens +
        totalUsage.outputTokens;
      if (consumed >= options.tokenBudget.hardLimit) {
        const err = new Error(
          `Token budget exceeded: ${consumed.toLocaleString()} / ${options.tokenBudget.hardLimit.toLocaleString()} tokens used. ` +
          `Raise tokenBudget.hardLimit in settings or start a new session.`
        );
        options.onEvent({ type: "error", error: err });
        return { finalMessage: { stop_reason: "end_turn", content: [], usage: { input_tokens: 0, output_tokens: 0 } }, updatedHistory: messages, totalUsage };
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
    let streamHandle;
    try {
      streamHandle = provider.stream({
        model: options.model,
        maxTokens: options.maxTokens,
        systemPrompt: options.systemPrompt,
        messages,
        tools: tools.getDefinitions(),
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

    totalUsage.inputTokens += usage.input_tokens;
    totalUsage.outputTokens += usage.output_tokens;
    totalUsage.cacheReadTokens += cacheRead;
    totalUsage.cacheWriteTokens += cacheWrite;
    totalUsage.estimatedCostUsd = calculateCost(options.model, totalUsage);

    stats?.updateUsage({
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
    });

    options.onEvent({
      type: "usage",
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
    });

    // ── 5. 追加 assistant 完整 content（转换为 Anthropic 历史格式）────────
    messages.push(normalizedToHistory(message.content));
    await notifyHistoryChange(options, messages);

    // ── 6. 检查 stop_reason ──────────────────────────────────────────────
    if (message.stop_reason === "end_turn" || message.stop_reason === "stop_sequence") {
      // I026: scan text content for [[CHECKPOINT: reason]] markers
      // When found: strip the marker, emit checkpoint event, pause loop for user review
      let checkpointMessage: string | null = null;
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
      return { finalMessage: message, updatedHistory: messages, totalUsage };
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
      options.onEvent({ type: "text_delta", delta: "\n[output truncated — continuing…]\n" });

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

      const { results: toolResults, allDenied } = await executeToolsWithParallelism(
        toolUseBlocks,
        tools,
        permissions,
        options.onEvent,
        stats,
        iterations,
        options.signal
      );

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
        return { finalMessage: message, updatedHistory: messages, totalUsage };
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

      messages.push({ role: "user", content: toolResults });
      await notifyHistoryChange(options, messages);
      waitingAfterTool = true;
      options.onEvent({ type: "status", phase: "waiting_model_after_tool", iteration: iterations });
      continue;
    }

    // 未知 stop_reason
    logger.warn("loop.unexpected_stop_reason", { stopReason: message.stop_reason });
    options.onEvent({ type: "status", phase: "completed", iteration: iterations, stopReason: message.stop_reason ?? "unknown" });
    options.onEvent({ type: "done", stopReason: message.stop_reason ?? "unknown" });
    return { finalMessage: message, updatedHistory: messages, totalUsage };
  }

  const err = new Error(`Agent loop exceeded ${maxIterations} iterations.`);
  options.onEvent({ type: "status", phase: "completed", iteration: iterations, stopReason: "max_iterations" });
  options.onEvent({ type: "error", error: err });
  throw err;
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
    finalMessage: {
      stop_reason: "end_turn",
      content: [],
      usage: { input_tokens: 0, output_tokens: 0 },
    },
    updatedHistory: messages,
    totalUsage,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Convert NormalizedBlock[] → Anthropic-compatible assistant message for history.
 * The history format is always Anthropic-style internally (works as-is for
 * Anthropic provider; OpenAI provider converts it back in toOAIMessages()).
 */
function normalizedToHistory(content: NormalizedBlock[]): ConversationMessage {
  return {
    role: "assistant",
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
  signal?: AbortSignal
): Promise<{ results: ToolResultParam[]; allDenied: boolean }> {

  // Phase 1: serial permission collection
  type DecisionRecord = { toolBlock: ToolUseBlock; decision: "allow" | "deny" };
  const decisions: DecisionRecord[] = [];

  for (const toolBlock of toolUseBlocks) {
    if (signal?.aborted) break;

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

  // Phase 2: parallel execution of approved tools
  const execTasks = decisions.map(({ toolBlock, decision }) => {
    if (decision === "deny") {
      return Promise.resolve<ToolResultParam>({
        type: "tool_result",
        tool_use_id: toolBlock.id,
        content: "Permission denied. Try a different approach or ask the user.",
        is_error: true,
      });
    }
    return executeSingleTool(toolBlock, tools, onEvent, stats, iteration, signal);
  });

  const settled = await Promise.allSettled(execTasks);

  const results = settled.map((outcome, i) => {
    if (outcome.status === "fulfilled") return outcome.value;
    const toolBlock = toolUseBlocks[i]!;
    logger.error("tool.parallel.rejected", outcome.reason);
    return {
      type: "tool_result" as const,
      tool_use_id: toolBlock.id,
      content: `Tool execution rejected unexpectedly: ${String(outcome.reason)}`,
      is_error: true,
    };
  });

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
