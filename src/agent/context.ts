import type { ConversationMessage } from "../types/agent.js";
import type { DevAISettings } from "../types/config.js";
import type { AIProvider } from "../providers/interface.js";
import { logger } from "../utils/logger.js";

const SUMMARY_MAX_TOKENS = 600;

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-sonnet-4-6": 200_000,
  "claude-opus-4-6": 200_000,
  "claude-haiku-4-5-20251001": 200_000,
  "claude-opus-4-5": 200_000,
  "claude-sonnet-4-5": 200_000,
};

export class ContextManager {
  private messages: ConversationMessage[] = [];
  private lastInputTokens = 0;
  // Accumulated summaries from previous compressions
  private summaryHistory: string[] = [];

  constructor(
    private settings: DevAISettings,
    private model: string
  ) {}

  append(message: ConversationMessage): void {
    this.messages.push(message);
    if (this.messages.length > this.settings.context.maxHistoryMessages) {
      this.messages = this.messages.slice(
        this.messages.length - this.settings.context.maxHistoryMessages
      );
    }
  }

  getHistory(): ConversationMessage[] {
    return [...this.messages];
  }

  /** Returns accumulated summaries to inject into system prompt */
  getSummaryContext(): string | null {
    if (this.summaryHistory.length === 0) return null;
    return `## 早期对话摘要（已压缩）\n\n${this.summaryHistory.join("\n\n---\n\n")}`;
  }

  updateTokenCount(usage: { input_tokens?: number; cache_read_input_tokens?: number }): void {
    this.lastInputTokens =
      (usage.input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0);
  }

  shouldCompact(): boolean {
    const contextWindow = MODEL_CONTEXT_WINDOWS[this.model] ?? 200_000;
    const usageRatio = this.lastInputTokens / contextWindow;
    const threshold = this.settings.context.compactionThreshold / 100;
    return usageRatio > threshold;
  }

  /**
   * Innovation 3: LLM-powered Smart Context Compression
   *
   * 与 Claude Code 的简单截断不同，这里：
   * 1. 用 Haiku（最便宜的模型）对被删除的消息生成语义摘要
   * 2. 将摘要保存到 summaryHistory，注入回系统提示
   * 3. 这样即使旧消息被删除，模型仍然知道"之前发生了什么"
   *
   * 成本：每次压缩约 $0.0002（haiku 非常便宜）
   * 收益：防止模型因遗忘早期上下文而重复工作或犯错
   */
  /**
   * Innovation 3 (fixed): use the *current* provider for summarization.
   * Previously used a hardcoded Anthropic Haiku call with `apiKey`, which
   * always 403-ed for DeepSeek/Groq/OpenRouter users → no summary → AI amnesia.
   * Now: pass the live AIProvider so DeepSeek uses DeepSeek, Anthropic uses Anthropic.
   */
  async compactWithSummary(provider: AIProvider, model: string): Promise<void> {
    if (this.messages.length <= 4) return;

    const keepCount = Math.max(4, Math.floor(this.settings.context.maxHistoryMessages / 2));
    const toSummarize = this.messages.slice(0, this.messages.length - keepCount);

    if (toSummarize.length === 0) return;

    logger.info("context.compact.start", {
      total: this.messages.length,
      toSummarize: toSummarize.length,
      keepCount,
    });

    // Generate summary using the current provider (works for any provider).
    // Clean messages first: DeepSeek/OAI reject orphaned tool_result (no preceding
    // tool_calls) and trailing tool_calls (no following tool_results).
    try {
      let cleanedForSummary = dropOrphanedToolResults(toSummarize);
      cleanedForSummary = dropTrailingToolCalls(cleanedForSummary);

      if (cleanedForSummary.length === 0) {
        this.summaryHistory.push(`[${toSummarize.length} 条早期消息已压缩]`);
      } else {
        const summaryMessages: ConversationMessage[] = [
          ...cleanedForSummary,
          {
            role: "user",
            content:
              "请总结以上对话中的关键内容，以便在后续对话中参考。重点：做了什么、发现了什么、当前状态。不超过400字。",
          },
        ];
        const handle = provider.stream({
          model,
          maxTokens: SUMMARY_MAX_TOKENS,
          systemPrompt:
            "你是一个对话摘要助手。从AI编程助手的对话历史中提取关键信息。" +
            "输出简洁摘要，包含：已完成的操作、发现的问题、重要决策、当前状态。不超过400字。",
          messages: summaryMessages,
          tools: [],
        });
        const msg = await handle.finalMessage();
        const textBlock = msg.content.find((b) => b.type === "text");
        if (textBlock?.type === "text") {
          this.summaryHistory.push(textBlock.text);
          logger.info("context.compact.summary_generated", { length: textBlock.text.length });
        }
      }
    } catch (err) {
      logger.warn("context.compact.summary_failed", err);
      this.summaryHistory.push(`[摘要生成失败：${toSummarize.length} 条早期消息已删除]`);
    }

    // Keep only the recent messages — then fix orphaned tool messages.
    // If the slice starts with a user message that contains tool_result blocks,
    // the corresponding assistant tool_calls message was dropped → API rejects.
    // Drop leading tool_result-only user messages until we reach a clean boundary.
    let kept = this.messages.slice(this.messages.length - keepCount);
    kept = dropOrphanedToolResults(kept);
    this.messages = kept;
    logger.info("context.compact.done", { remaining: this.messages.length });
  }

  /**
   * Fallback: simple compaction without LLM summary
   * Used when no API key available or in tests
   */
  compact(): void {
    if (this.messages.length <= 2) return;
    const keepCount = Math.max(2, Math.floor(this.settings.context.maxHistoryMessages / 2));
    const dropped = this.messages.length - keepCount;
    if (dropped <= 0) return;

    logger.info("context.compact.simple", { dropped, keepCount });
    const sliced = dropOrphanedToolResults(this.messages.slice(dropped));
    const placeholder: ConversationMessage = {
      role: "user",
      content: `[系统：${dropped} 条早期消息已压缩以控制token用量。对话从最近 ${keepCount} 条继续。]`,
    };
    this.messages = [placeholder, ...sliced];
  }

  clear(): void {
    this.messages = [];
    this.lastInputTokens = 0;
    this.summaryHistory = [];
  }

  get messageCount(): number {
    return this.messages.length;
  }

  get estimatedTokens(): number {
    return this.lastInputTokens;
  }
}

/**
 * After slicing history, the first message(s) may be user messages that contain
 * only tool_result blocks — orphaned because the matching assistant tool_calls
 * message was removed by the slice. DeepSeek/OpenAI reject such sequences.
 * Drop those leading orphaned tool-result messages.
 */
function dropOrphanedToolResults(msgs: ConversationMessage[]): ConversationMessage[] {
  let i = 0;
  while (i < msgs.length) {
    const msg = msgs[i]!;
    if (msg.role === "user" && Array.isArray(msg.content)) {
      const allToolResults = msg.content.every(
        (b) => typeof b === "object" && "type" in b && b.type === "tool_result"
      );
      if (allToolResults) { i++; continue; }
    }
    break;
  }
  return msgs.slice(i);
}

/**
 * Drop trailing assistant messages that contain tool_use blocks without
 * corresponding tool_result responses. This happens when max_tokens cuts
 * off mid-tool_call or when the slice end falls between tool_calls and
 * tool_results. DeepSeek/OAI reject such sequences with 400.
 */
function dropTrailingToolCalls(msgs: ConversationMessage[]): ConversationMessage[] {
  let end = msgs.length;
  while (end > 0) {
    const msg = msgs[end - 1]!;
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const hasToolUse = msg.content.some(
        (b) => typeof b === "object" && "type" in b && b.type === "tool_use"
      );
      if (hasToolUse) { end--; continue; }
    }
    break;
  }
  return msgs.slice(0, end);
}
