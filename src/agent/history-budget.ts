import type { ConversationMessage } from "../types/agent.js";
import { logger } from "../utils/logger.js";

/**
 * Working-set budget for the conversation history.
 *
 * Every model turn resends the whole history, so an unbounded transcript costs
 * O(n²) tokens: a 260-turn session measured 313K tokens of context and
 * 54M tokens of cumulative billed input — a 172× amplification.
 *
 * The existing ContextManager compaction only fires at 80% of the context
 * WINDOW (160K tokens), which prevents overflow but does nothing about cost —
 * by then every turn is already billing 160K input. This keeps the working set
 * small from the start instead.
 *
 * Two mechanisms, cheapest first:
 *   1. Age tool results outside the recent window down to a short excerpt.
 *      Nothing is dropped and no tool_use/tool_result pair is broken.
 *   2. If still over budget, drop the middle of the transcript, keeping the
 *      original goal and the recent window, with a marker in between.
 */

export interface HistoryBudgetOptions {
  /** Target size of the resent working set. */
  maxContextTokens: number;
  /** Trailing messages always kept verbatim. */
  keepRecentMessages: number;
  /** Tool-result length retained for messages outside the recent window. */
  agedToolResultChars: number;
  /**
   * Replaces the dropped span. Supplying a summary here is what turns a trim
   * into a compaction; omitting it leaves only a "content removed" marker.
   */
  summaryMessages: ConversationMessage[];
}

export interface HistoryBudgetResult {
  messages: ConversationMessage[];
  before: number;
  after: number;
  agedResults: number;
  droppedMessages: number;
  /**
   * Canonical index range the budget removed, `[start, end)`. The caller needs
   * it to summarise exactly what is about to disappear — dropping content and
   * only then deciding what to say about it is how detail gets lost.
   */
  droppedRange: { start: number; end: number } | null;
}

export const DEFAULT_HISTORY_BUDGET: HistoryBudgetOptions = {
  maxContextTokens: 60_000,
  keepRecentMessages: 20,
  agedToolResultChars: 800,
  summaryMessages: [],
};

const CJK = /[㐀-鿿豈-﫿぀-ヿ가-힯]/g;

/**
 * Cheap token estimate. A CJK character is roughly one token; Latin text and
 * code run about 3.5 characters per token. Exactness is not required — this
 * only decides when to shrink.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = text.match(CJK)?.length ?? 0;
  return Math.ceil(cjk + (text.length - cjk) / 3.5);
}

/**
 * Canonical messages are immutable once appended, so their size never changes.
 * Deriving the working context on every turn would otherwise rescan the whole
 * transcript each time — O(n²) CPU across a long task.
 */
const MESSAGE_TOKEN_CACHE = new WeakMap<object, number>();

export function estimateMessageTokens(message: ConversationMessage): number {
  const cached = MESSAGE_TOKEN_CACHE.get(message);
  if (!message.providerState && cached !== undefined) return cached;
  const computed = computeMessageTokens(message);
  MESSAGE_TOKEN_CACHE.set(message, computed);
  return computed;
}

function computeMessageTokens(message: ConversationMessage): number {
  let total = estimateTokens(typeof message.content === "string" ? message.content : "");
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      total += 8; // per-block protocol overhead
      if (block.type === "text") {
        total += estimateTokens(block.text);
      } else if (block.type === "tool_use") {
        total += estimateTokens(JSON.stringify(block.input ?? null));
      } else if (block.type === "tool_result") {
        total += estimateTokens(toolResultText(block.content));
      }
    }
  }
  // DeepSeek thinking text rides along with the message when present.
  const state = message.providerState;
  if (state?.protocol === "deepseek-chat" && typeof state.reasoningContent === "string") {
    total += estimateTokens(state.reasoningContent);
  }
  return total + 4;
}

/** tool_result content is either a plain string or a block array. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      typeof part === "object" && part !== null && "text" in part &&
      typeof (part as { text: unknown }).text === "string"
        ? (part as { text: string }).text
        : "")
    .join("");
}

export function estimateHistoryTokens(messages: ConversationMessage[]): number {
  let total = 0;
  for (const message of messages) total += estimateMessageTokens(message);
  return total;
}

export function applyHistoryBudget(
  messages: ConversationMessage[],
  options: Partial<HistoryBudgetOptions> = {},
): HistoryBudgetResult {
  const opts = { ...DEFAULT_HISTORY_BUDGET, ...options };
  const before = estimateHistoryTokens(messages);
  if (before <= opts.maxContextTokens) {
    return { messages, before, after: before, agedResults: 0, droppedMessages: 0, droppedRange: null };
  }

  const recentFrom = Math.max(0, messages.length - opts.keepRecentMessages);
  const aged = ageToolResults(messages, recentFrom, opts.agedToolResultChars);
  let working = aged.messages;
  let after = estimateHistoryTokens(working);
  let droppedMessages = 0;
  let droppedRange: { start: number; end: number } | null = null;

  if (after > opts.maxContextTokens) {
    const trimmed = dropMiddle(working, opts, options.summaryMessages ?? []);
    droppedMessages = trimmed.droppedCount;
    droppedRange = trimmed.range;
    working = trimmed.messages;
    after = estimateHistoryTokens(working);
  }
  if (after > opts.maxContextTokens) {
    throw new Error(`上下文超过请求预算（约 ${after} / ${opts.maxContextTokens} tokens）。请缩小本次输入或提高上下文预算；原始会话已保留，未发送超限请求。`);
  }

  if (aged.count > 0 || droppedMessages > 0) {
    logger.info("history_budget.applied", {
      before,
      after,
      agedResults: aged.count,
      droppedMessages,
      saved: before - after,
    });
  }
  return { messages: working, before, after, agedResults: aged.count, droppedMessages, droppedRange };
}

/**
 * Replace the body of older tool results with a head excerpt. The block itself
 * survives, so every tool_use keeps its matching tool_result and the provider
 * still sees a well-formed transaction.
 */
function ageToolResults(
  messages: ConversationMessage[],
  recentFrom: number,
  limit: number,
): { messages: ConversationMessage[]; count: number } {
  let count = 0;
  const out = messages.map((message, index) => {
    if (index >= recentFrom || !Array.isArray(message.content)) return message;
    let changed = false;
    const content = message.content.map((block) => {
      if (block.type !== "tool_result") return block;
      const body = block.content;
      if (typeof body !== "string" || body.length <= limit) return block;
      changed = true;
      count++;
      return {
        ...block,
        content:
          `${body.slice(0, limit)}\n[早期工具结果已压缩：原文 ${body.length.toLocaleString()} 字符，` +
          "仅保留开头。需要完整内容请先使用结果中的证据 ID 调用 evidence_read；不要为找回日志重跑有副作用的工具。]",
      };
    });
    return changed
      ? { ...message, content } as ConversationMessage
      : message;
  });
  return { messages: out, count };
}

/**
 * Keep the opening request and the recent window, drop the middle. The kept
 * tail is repaired so it cannot start with tool results whose tool_use was
 * dropped, or end with tool calls whose results were dropped — both are
 * rejected by OpenAI-compatible providers.
 */
function dropMiddle(
  messages: ConversationMessage[],
  opts: HistoryBudgetOptions,
  summaryMessages: ConversationMessage[],
): { messages: ConversationMessage[]; droppedCount: number; range: { start: number; end: number } | null } {
  const head = messages.length > 0 && isPlainUserMessage(messages[0]!) ? [messages[0]!] : [];
  let keep = Math.max(1, Math.min(opts.keepRecentMessages, messages.length - head.length));
  let tail = repairBoundaries(messages.slice(messages.length - keep));

  // Shrink the window until the result fits, but never below a usable turn.
  while (
    estimateHistoryTokens([...head, ...summaryMessages, ...tail]) + 150 > opts.maxContextTokens &&
    keep > 1
  ) {
    keep = Math.floor(keep / 2);
    tail = repairBoundaries(messages.slice(messages.length - keep));
  }

  const droppedCount = messages.length - head.length - tail.length;
  if (droppedCount <= 0) {
    return { messages, droppedCount: 0, range: null };
  }
  const range = { start: head.length, end: messages.length - tail.length };

  // A caller that summarised the dropped span supplies it here. Without one
  // the marker is all the model gets, which is truncation rather than
  // compaction — it must re-derive everything it can no longer see.
  const bridge: ConversationMessage[] = summaryMessages.length > 0
    ? summaryMessages
    : [{
        role: "user",
        content:
          `[系统：为控制成本，中间 ${droppedCount} 条历史消息已省略，且未生成摘要。` +
          "如需早期细节，请重新读取文件或重新执行相应工具，不要凭记忆假设。]",
      }];
  return { messages: [...head, ...bridge, ...tail], droppedCount, range };
}

function isPlainUserMessage(message: ConversationMessage): boolean {
  return message.role === "user" && (typeof message.content === "string" ||
    Array.isArray(message.content) && message.content.every((block) => block.type === "text"));
}

/** Trim both ends so no tool_use or tool_result is left without its partner. */
export function repairBoundaries(messages: ConversationMessage[]): ConversationMessage[] {
  let start = 0;
  while (start < messages.length) {
    const message = messages[start]!;
    if (message.role === "user" && Array.isArray(message.content)) {
      if (message.content.every((block) => block.type === "tool_result")) {
        start++;
        continue;
      }
    }
    break;
  }
  let end = messages.length;
  while (end > start) {
    const message = messages[end - 1]!;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      if (message.content.some((block) => block.type === "tool_use")) {
        end--;
        continue;
      }
    }
    break;
  }
  return messages.slice(start, end);
}
