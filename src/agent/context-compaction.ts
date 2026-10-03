import type { AIProvider } from "../providers/interface.js";
import type { ConversationMessage } from "../types/agent.js";
import { estimateTokens } from "./history-budget.js";
import { logger } from "../utils/logger.js";
import { createHash } from "node:crypto";

/**
 * Context compaction.
 *
 * Dropping the middle of a transcript and leaving a "content removed" note is
 * truncation, not compaction: on a real 528-message task the model ended up
 * seeing 21 messages and was told to re-read everything else. The saving in
 * context then reappears as extra tool rounds.
 *
 * What replaces the dropped span is built in two clearly separated layers:
 *
 *   1. FACTS — extracted deterministically from the dropped tool calls. Files
 *      written, commands run, tests attempted. These are evidence.
 *   2. NARRATIVE — a model-written recollection of intent, findings and
 *      decisions. Useful, and explicitly NOT evidence.
 *
 * The separation matters because a free-form summary will happily write "已实现
 * 并通过测试", and a later turn would then treat that sentence as proof. The
 * rendered block says which half is which, every time.
 */

const SUMMARY_MAX_TOKENS = 700;
/** Re-summarising on every turn would cost more than it saves. */
const RESUMMARISE_AFTER_MESSAGES = 20;

export interface CompactionState {
  /** Retry only after new material arrives; failed summaries must not loop each turn. */
  lastAttemptedThrough?: number;
  consecutiveFailures?: number;
  /** Factual extraction and narrative generation advance independently. */
  factsThrough?: number;
  canonicalPrefixHash?: string;
  /** Canonical index the narrative currently covers, exclusive. */
  summarisedThrough: number;
  /** Accumulated narratives, oldest first. */
  narratives: string[];
  /** Facts accumulated across every compaction so far. */
  facts: CompactedFacts;
  modelCalls: number;
  tokensSpent: { input: number; output: number };
  failures: number;
}

export interface CompactedFacts {
  filesTouched: string[];
  commandsRun: string[];
  toolCallCount: number;
  errorCount: number;
}

export function createCompactionState(): CompactionState {
  return {
    summarisedThrough: 0,
    factsThrough: 0,
    narratives: [],
    facts: { filesTouched: [], commandsRun: [], toolCallCount: 0, errorCount: 0 },
    modelCalls: 0,
    tokensSpent: { input: 0, output: 0 },
    failures: 0,
    lastAttemptedThrough: 0,
    consecutiveFailures: 0,
  };
}

/** True when enough new material has been dropped to be worth another call. */
export function shouldSummarise(state: CompactionState, dropEnd: number): boolean {
  const retryGap = Math.min(RESUMMARISE_AFTER_MESSAGES, 2 ** Math.min(state.consecutiveFailures ?? 0, 5));
  return dropEnd - state.summarisedThrough >= RESUMMARISE_AFTER_MESSAGES
    && (!(state.consecutiveFailures) || dropEnd - (state.lastAttemptedThrough ?? 0) >= retryGap);
}

function prefixHash(messages: ConversationMessage[], through: number): string {
  return createHash("sha256").update(JSON.stringify(messages.slice(0, through).map(({role, content}) => ({role, content})))).digest("hex");
}

/** An edited or replaced transcript must never inherit a stale summary. */
export function validateCompactionState(state: CompactionState, messages: ConversationMessage[]): void {
  const through = state.factsThrough ?? state.summarisedThrough;
  if (through > 0 && (through > messages.length || state.canonicalPrefixHash !== prefixHash(messages, through))) {
    delete state.canonicalPrefixHash;
    Object.assign(state, createCompactionState());
  }
}

/**
 * Facts read straight off the dropped messages. No model involved, so nothing
 * here can be invented — and a failed narrative still leaves these behind.
 */
export function extractFacts(messages: ConversationMessage[]): CompactedFacts {
  const filesTouched = new Set<string>();
  const commandsRun: string[] = [];
  let toolCallCount = 0;
  let errorCount = 0;
  const successful = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "tool_result" && block.is_error !== true) successful.add(block.tool_use_id);
    }
  }

  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "tool_use") {
        toolCallCount++;
        const input = (block.input ?? {}) as Record<string, unknown>;
        const name = block.name;
        if ((name === "file_write" || name === "file_edit") && successful.has(block.id)) {
          const path = typeof input["path"] === "string" ? input["path"] : null;
          if (path) filesTouched.add(path);
        } else if (name === "bash") {
          const command = typeof input["command"] === "string" ? input["command"] : null;
          if (command) commandsRun.push(command.replace(/\s+/g, " ").slice(0, 120));
        }
      } else if (block.type === "tool_result" && block.is_error === true) {
        errorCount++;
      }
    }
  }
  return {
    filesTouched: [...filesTouched],
    commandsRun,
    toolCallCount,
    errorCount,
  };
}

const NARRATIVE_SYSTEM = `你在为一个 AI 编程助手压缩即将被丢弃的对话历史。

只输出以下五节，每节 1–4 条，每条一句话。没有内容的节写「无」。
不要客套，不要复述本提示，不要输出这五节以外的任何文字。

## 意图
用户和助手当时在试图做什么。

## 发现
读到/查到的关键事实（报错、文件结构、接口约定等）。

## 决策
做过的选择和放弃的方案，附一句为什么。

## 当前状态
被丢弃区间结束时，事情进行到哪一步。

## 未解决
还没搞定的问题。

严禁把"已完成/已通过/已验证"写成确定结论。
如果助手当时声称完成，写成"助手声称 X 已完成（未核验）"。`;

/**
 * Ask the current provider to summarise the dropped span.
 *
 * Uses whichever provider the run is already using — an earlier version
 * hardcoded an Anthropic model, which meant summarisation silently 403'd for
 * every other provider and the history was simply lost.
 */
async function writeNarrative(
  provider: AIProvider,
  model: string,
  dropped: ConversationMessage[],
  priorNarrative: string | undefined,
  state: CompactionState,
  signal?: AbortSignal,
): Promise<string | null> {
  const transcript = dropped
    .map((message) => renderForSummary(message))
    .filter(Boolean)
    .join("\n")
    .slice(-24_000);

  const prompt = priorNarrative
    ? `已有摘要：\n${priorNarrative}\n\n请合并以下新对话，生成替代已有摘要的完整摘要；保留目标、约束、授权与未解决事项：\n\n${transcript}`
    : `请为以下对话生成摘要：\n\n${transcript}`;

  try {
    state.modelCalls++;
    const handle = provider.stream({
      model,
      purpose: "compaction",
      maxTokens: SUMMARY_MAX_TOKENS,
      systemPrompt: NARRATIVE_SYSTEM,
      messages: [{ role: "user", content: prompt }],
      tools: [],
      ...(signal ? { signal } : {}),
    });
    for await (const _delta of handle.deltas()) { /* drain */ }
    const final = await handle.finalMessage();
    state.tokensSpent.input += final.usage.input_tokens ?? 0;
    state.tokensSpent.output += final.usage.output_tokens ?? 0;

    const text = final.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("")
      .trim();
    if (!text.length) {
      state.failures++;
      return null;
    }
    return text.slice(0, 6000);
  } catch (err) {
    // A failed summary must never break the run. The facts layer still
    // survives, and the caller falls back to the plain marker.
    state.failures++;
    logger.warn("compaction.narrative_failed", { errorType: err instanceof Error ? err.name : "unknown" });
    return null;
  }
}

function renderForSummary(message: ConversationMessage): string {
  const role = message.role === "user" ? "用户" : "助手";
  if (typeof message.content === "string") {
    return `${role}: ${message.content.slice(0, 1_200)}`;
  }
  if (!Array.isArray(message.content)) return "";
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text") parts.push(block.text.slice(0, 1_200));
    else if (block.type === "tool_use") {
      parts.push(`[调用 ${block.name} ${JSON.stringify(block.input ?? {}).slice(0, 300)}]`);
    } else if (block.type === "tool_result") {
      const body = typeof block.content === "string" ? block.content : "";
      parts.push(`[结果${block.is_error ? "(失败)" : ""} ${body.slice(0, 400)}]`);
    }
  }
  return parts.length > 0 ? `${role}: ${parts.join(" ")}` : "";
}

/**
 * Advance the compaction state to cover `[0, dropEnd)` of the canonical
 * transcript, generating a new narrative when enough fresh material warrants
 * one. Facts are always refreshed; they cost nothing.
 */
export async function advanceCompaction(
  state: CompactionState,
  canonical: ConversationMessage[],
  dropEnd: number,
  provider: AIProvider,
  model: string,
  signal?: AbortSignal,
): Promise<CompactionState> {
  if (signal?.aborted) return state;
  validateCompactionState(state, canonical);
  dropEnd = Math.min(dropEnd, canonical.length);
  // Re-extract the prefix so a result arriving in a later increment can resolve
  // an earlier attempted call, without double-counting calls or failures.
  if (dropEnd > (state.factsThrough ?? 0)) {
    state.facts = extractFacts(canonical.slice(0, dropEnd));
    state.factsThrough = dropEnd;
    state.canonicalPrefixHash = prefixHash(canonical, dropEnd);
  }
  if (dropEnd <= state.summarisedThrough) return state;
  const fresh = canonical.slice(state.summarisedThrough, dropEnd);
  if (fresh.length === 0) return state;

  if (shouldSummarise(state, dropEnd)) {
    state.lastAttemptedThrough = dropEnd;
    const narrative = await writeNarrative(
      provider, model, fresh, state.narratives.at(-1), state, signal,
    );
    if (narrative) {
      state.narratives = [narrative];
      state.summarisedThrough = dropEnd;
      state.consecutiveFailures = 0;
    } else {
      state.consecutiveFailures = (state.consecutiveFailures ?? 0) + 1;
    }
  }
  return state;
}

/**
 * The block that stands in for the dropped span. Facts and narrative are
 * labelled separately so a later turn cannot read a recollection as proof.
 */
export function renderCompaction(
  state: CompactionState,
  droppedCount: number,
): ConversationMessage[] {
  if ((state.factsThrough ?? state.summarisedThrough) === 0) return [];
  const lines: string[] = [
    `[系统：为控制上下文成本，中间 ${droppedCount} 条历史已压缩为下列内容。`,
    "「工具执行记录」只证明工具返回结果，不证明业务验收通过；「叙事回忆」不是证据。]",
    "",
    "## 工具执行记录（成功写入与命令尝试）",
  ];
  const facts = state.facts;
  lines.push(`- 工具调用 ${facts.toolCallCount} 次，其中失败 ${facts.errorCount} 次`);
  if (facts.filesTouched.length > 0) {
    lines.push(`- 写入/编辑过的文件（${facts.filesTouched.length}）：${facts.filesTouched.slice(0, 25).join("、")}`);
  }
  if (facts.commandsRun.length > 0) {
    const recent = facts.commandsRun.slice(-8);
    lines.push("- 执行过的命令（最近几条）：");
    for (const command of recent) lines.push(`    ${command}`);
  }

  if (state.narratives.length > 0) {
    lines.push("", "## 叙事回忆（模型生成，未经核验）");
    lines.push(state.narratives.join("\n\n---\n\n"));
  } else if (state.failures > 0) {
    lines.push("", "## 叙事回忆");
    lines.push("摘要生成失败，仅保留上方事实。早期细节请用 evidence_read 找回工具证据或重新读取文件。");
  }

  lines.push(
    "",
    "以上「叙事回忆」中若出现「已完成/已通过」，必须重新验证后才能采信。",
    "需要早期细节时用 evidence_read 找回工具证据或重新读取文件，不要凭这段回忆下结论。",
  );

  return [{ role: "user", content: lines.join("\n") }];
}

/** Size of the compaction block, for cost accounting. */
export function compactionTokens(state: CompactionState, droppedCount: number): number {
  return renderCompaction(state, droppedCount)
    .reduce((sum, message) =>
      sum + estimateTokens(typeof message.content === "string" ? message.content : ""), 0);
}
