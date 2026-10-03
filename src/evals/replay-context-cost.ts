/**
 * Offline context-cost replay.
 *
 * Reconstructs, turn by turn, what a strategy would actually put on the wire for
 * a recorded session, and decomposes it into fixed overhead, conversation,
 * tool results and provider continuation state.
 *
 * This measures an ESTIMATED tokenizer against a recorded transcript. It is not
 * a provider bill and must never be reported as one: no cache hit/miss, no
 * price table, no output or thinking tokens generated at run time, and a local
 * estimator that will disagree with any server-side tokenizer. Every number it
 * emits is namespaced under `estimated` and tagged `measurementKind:
 * "offline_estimate"` for exactly that reason.
 *
 *   npm run replay:context -- --fixture <path> [--strategy alpha8] [--out <dir>]
 *   npm run replay:context -- --fixture <path> --strategy all
 *
 * It never touches the network and never calls a model.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { TOOL_DEFINITIONS } from "../tools/definitions.js";
import {
  applyHistoryBudget,
  estimateTokens,
  DEFAULT_HISTORY_BUDGET,
  type HistoryBudgetOptions,
} from "../agent/history-budget.js";
import type { ConversationMessage } from "../types/agent.js";

export type StrategyName = "legacy" | "alpha8" | "candidate";

/** Bump when a strategy's meaning changes, so old artifacts stay comparable. */
export const STRATEGY_VERSION = 3;

/**
 * How the resent working set is produced.
 *  - `none`      no budget; the whole transcript goes every turn.
 *  - `in_place`  alpha.8 behaviour: the budget OVERWRITES the transcript, so
 *                each turn starts from the already-trimmed array. It oscillates
 *                (trim → regrow → trim) and destroys the canonical record.
 *  - `derived`   current behaviour: the transcript only grows and each turn
 *                derives a fresh working context from it.
 */
export type HistoryMode = "none" | "in_place" | "derived";

export interface StrategyConfig {
  name: StrategyName;
  historyMode: HistoryMode;
  historyBudget: Partial<HistoryBudgetOptions> | null;
  /** Resend the thinking text of every past tool turn, not just the current one. */
  resendAllReasoning: boolean;
  note: string;
}

export const STRATEGIES: Record<StrategyName, StrategyConfig> = {
  legacy: {
    name: "legacy",
    historyMode: "none",
    historyBudget: null,
    resendAllReasoning: true,
    note: "0.11.0-alpha.7 及更早：历史无上限，每轮回传全部思维链",
  },
  alpha8: {
    name: "alpha8",
    historyMode: "in_place",
    historyBudget: DEFAULT_HISTORY_BUDGET,
    resendAllReasoning: false,
    note: "0.11.0-alpha.8：历史预算原地覆盖会话数组（会破坏 canonical 记录）+ 仅回传待续接轮思维链",
  },
  candidate: {
    name: "candidate",
    historyMode: "derived",
    historyBudget: DEFAULT_HISTORY_BUDGET,
    resendAllReasoning: true,
    note: "0.11.0-alpha.12：保留各轮协议续接状态并派生工作上下文；离线估计不含摘要调用",
  },
};

export interface TurnMetric {
  turn: number;
  messageCount: number;
  estimatedSystemTokens: number;
  estimatedToolSchemaTokens: number;
  estimatedConversationTokens: number;
  estimatedToolResultTokens: number;
  estimatedReasoningStateTokens: number;
  estimatedInputTokens: number;
}

export interface ReplayReport {
  measurementKind: "offline_estimate";
  disclaimer: string;
  strategy: StrategyName;
  strategyVersion: number;
  strategyNote: string;
  strategyConfig: {
    historyMode: HistoryMode;
    historyBudget: Partial<HistoryBudgetOptions> | null;
    resendAllReasoning: boolean;
  };
  fixture: { path: string; sha256: string; messageCount: number };
  environment: {
    gitCommit: string;
    gitDirty: boolean;
    /** Hash of this script, so a changed replay cannot be mistaken for a changed result. */
    replayScriptSha256: string;
    node: string;
    platform: string;
    arch: string;
    generatedAt: string;
  };
  turns: number;
  estimated: {
    resentInputTokens: number;
    peakInputTokens: number;
    meanInputTokens: number;
    systemTokens: number;
    toolSchemaTokens: number;
    conversationTokens: number;
    toolResultTokens: number;
    reasoningStateTokens: number;
  };
  /** Non-token effects that decide whether a token saving was legitimate. */
  sideEffects: { contextTrims: number; agedToolResults: number; droppedMessages: number };
  perTurn: TurnMetric[];
}

// ── wire-shape decomposition ────────────────────────────────────────────────

/** Index of the assistant tool-call turn a provider is continuing. */
function lastToolCallAssistant(messages: ConversationMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    if (message.content.some((block) => block.type === "tool_use")) return index;
  }
  return -1;
}

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

interface Decomposition {
  conversation: number;
  toolResults: number;
  reasoningState: number;
}

/** Split the resent transcript into the categories a cost decision acts on. */
export function decompose(
  messages: ConversationMessage[],
  resendAllReasoning: boolean,
): Decomposition {
  const continuation = lastToolCallAssistant(messages);
  let conversation = 0;
  let toolResults = 0;
  let reasoningState = 0;

  for (const [index, message] of messages.entries()) {
    conversation += 4; // per-message protocol overhead
    if (typeof message.content === "string") {
      conversation += estimateTokens(message.content);
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        conversation += 8; // per-block overhead
        if (block.type === "text") {
          conversation += estimateTokens(block.text);
        } else if (block.type === "tool_use") {
          conversation += estimateTokens(JSON.stringify(block.input ?? null));
        } else if (block.type === "tool_result") {
          toolResults += estimateTokens(toolResultText(block.content));
        }
      }
    }
    const state = message.providerState;
    if (state?.protocol === "deepseek-chat" && typeof state.reasoningContent === "string") {
      if (resendAllReasoning || index === continuation) {
        reasoningState += estimateTokens(state.reasoningContent);
      }
    }
  }
  return { conversation, toolResults, reasoningState };
}

// ── replay ──────────────────────────────────────────────────────────────────

export function replay(
  messages: ConversationMessage[],
  strategy: StrategyConfig,
  fixed: { systemTokens: number; toolSchemaTokens: number },
): { perTurn: TurnMetric[]; sideEffects: ReplayReport["sideEffects"] } {
  const perTurn: TurnMetric[] = [];
  const sideEffects = { contextTrims: 0, agedToolResults: 0, droppedMessages: 0 };
  // `live` is the array the strategy carries forward. Under `in_place` the
  // budget overwrites it — precisely the alpha.8 behaviour being measured.
  // Under `derived` it only grows and each turn derives a separate context.
  let live: ConversationMessage[] = [];
  let turn = 0;

  for (const message of messages) {
    if (message.role !== "assistant") {
      // User turns and tool results are inputs: they are present before the
      // next request is made.
      live.push(message);
      continue;
    }

    // An assistant message is OUTPUT. The request that produced it was sent
    // with the transcript as it stood BEFORE it existed — counting it here
    // would bill a turn for text the model had not written yet. Its cost
    // appears only in later requests, once it is part of the history.
    turn++;
    let working = live;
    if (strategy.historyMode !== "none" && strategy.historyBudget) {
      const result = applyHistoryBudget(live, strategy.historyBudget);
      working = result.messages;
      if (result.after < result.before) {
        sideEffects.contextTrims++;
        sideEffects.agedToolResults += result.agedResults;
        sideEffects.droppedMessages += result.droppedMessages;
      }
      if (strategy.historyMode === "in_place") {
        // The destructive step: the transcript itself becomes the trimmed set,
        // and it happens before the request, exactly as alpha.8 did it.
        live = result.messages;
      }
    }

    const parts = decompose(working, strategy.resendAllReasoning);
    perTurn.push({
      turn,
      messageCount: working.length,
      estimatedSystemTokens: fixed.systemTokens,
      estimatedToolSchemaTokens: fixed.toolSchemaTokens,
      estimatedConversationTokens: parts.conversation,
      estimatedToolResultTokens: parts.toolResults,
      estimatedReasoningStateTokens: parts.reasoningState,
      estimatedInputTokens:
        fixed.systemTokens + fixed.toolSchemaTokens +
        parts.conversation + parts.toolResults + parts.reasoningState,
    });

    // Only now does the output join the history the next request will carry.
    live.push(message);
  }
  return { perTurn, sideEffects };
}

function sum(rows: TurnMetric[], pick: (row: TurnMetric) => number): number {
  return rows.reduce((total, row) => total + pick(row), 0);
}

export function buildReport(
  fixturePath: string,
  raw: string,
  messages: ConversationMessage[],
  strategy: StrategyConfig,
  fixed: { systemTokens: number; toolSchemaTokens: number },
): ReplayReport {
  const { perTurn, sideEffects } = replay(messages, strategy, fixed);
  const totals = sum(perTurn, (row) => row.estimatedInputTokens);
  return {
    measurementKind: "offline_estimate",
    disclaimer:
      "本地启发式估算，非 Provider 账单。不含缓存命中/未命中、价格、输出与思考 token，" +
      "且与服务端 tokenizer 存在误差。仅用于策略之间的相对比较。" +
      "注意：本重放不模拟上下文压缩 —— 真实运行会额外产生摘要模型调用，且摘要块比裸标记更大，" +
      "因此 candidate 数字是真实成本的下界，不是上界。",
    strategy: strategy.name,
    strategyVersion: STRATEGY_VERSION,
    strategyNote: strategy.note,
    strategyConfig: {
      historyMode: strategy.historyMode,
      historyBudget: strategy.historyBudget,
      resendAllReasoning: strategy.resendAllReasoning,
    },
    fixture: {
      path: path.basename(fixturePath),
      sha256: crypto.createHash("sha256").update(raw).digest("hex"),
      messageCount: messages.length,
    },
    environment: gitEnvironment(),
    turns: perTurn.length,
    estimated: {
      resentInputTokens: totals,
      peakInputTokens: perTurn.reduce((peak, row) => Math.max(peak, row.estimatedInputTokens), 0),
      meanInputTokens: perTurn.length > 0 ? Math.round(totals / perTurn.length) : 0,
      systemTokens: sum(perTurn, (row) => row.estimatedSystemTokens),
      toolSchemaTokens: sum(perTurn, (row) => row.estimatedToolSchemaTokens),
      conversationTokens: sum(perTurn, (row) => row.estimatedConversationTokens),
      toolResultTokens: sum(perTurn, (row) => row.estimatedToolResultTokens),
      reasoningStateTokens: sum(perTurn, (row) => row.estimatedReasoningStateTokens),
    },
    sideEffects,
    perTurn,
  };
}

function gitEnvironment(): ReplayReport["environment"] {
  let gitCommit = "unknown";
  let gitDirty = false;
  try {
    gitCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    gitDirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0;
  } catch { /* not a repo or git unavailable */ }
  return {
    gitCommit,
    gitDirty,
    replayScriptSha256: replayScriptHash(),
    node: process.version,
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    generatedAt: new Date().toISOString(),
  };
}

/** Hash of this file — a changed replay must not read as a changed result. */
function replayScriptHash(): string {
  try {
    const self = new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    return crypto.createHash("sha256").update(fs.readFileSync(self)).digest("hex");
  } catch {
    return "unknown";
  }
}

/** Fixed per-turn overhead. Kept out of the fixture so it reflects current code. */
export async function measureFixedOverhead(): Promise<{ systemTokens: number; toolSchemaTokens: number }> {
  const toolSchemaTokens = estimateTokens(JSON.stringify(TOOL_DEFINITIONS));
  try {
    const [{ buildSystemPrompt }, { loadSettings }] = await Promise.all([
      import("../agent/system-prompt.js"),
      import("../config/settings.js"),
    ]);
    const settings = await loadSettings();
    const systemTokens = estimateTokens(
      await buildSystemPrompt(process.cwd(), null, settings, null, "replay"),
    );
    return { systemTokens, toolSchemaTokens };
  } catch {
    // A replay must stay runnable without user settings. Reporting 0 here would
    // understate fixed overhead, so the caller sees it in the artifact as 0 and
    // the disclaimer covers it — never silently folded into another bucket.
    return { systemTokens: 0, toolSchemaTokens };
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag?.startsWith("--")) out[flag.slice(2)] = argv[++index] ?? "true";
  }
  return out;
}

function loadMessages(raw: string): ConversationMessage[] {
  const parsed = JSON.parse(raw) as unknown;
  if (Array.isArray(parsed)) return parsed as ConversationMessage[];
  const record = parsed as { messages?: unknown };
  if (Array.isArray(record.messages)) return record.messages as ConversationMessage[];
  throw new Error("fixture 必须是消息数组，或包含 messages 数组的对象");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const fixturePath = args["fixture"];
  if (!fixturePath) {
    console.error(
      "用法：npm run replay:context -- --fixture <path> [--strategy legacy|alpha8|candidate|all] [--out <dir>]",
    );
    process.exitCode = 2;
    return;
  }

  const raw = fs.readFileSync(fixturePath, "utf8");
  const messages = loadMessages(raw);
  const fixed = await measureFixedOverhead();
  const requested = args["strategy"] ?? "alpha8";
  const names: StrategyName[] = requested === "all"
    ? ["legacy", "alpha8", "candidate"]
    : [requested as StrategyName];

  const outDir = args["out"] ?? path.join(".benchmark-results", "token-efficiency");
  fs.mkdirSync(outDir, { recursive: true });

  const rows: Array<{ strategy: string; total: number; peak: number; trims: number }> = [];
  for (const name of names) {
    const strategy = STRATEGIES[name];
    if (!strategy) throw new Error(`未知策略：${name}`);
    const report = buildReport(fixturePath, raw, messages, strategy, fixed);
    const base = path.basename(fixturePath).replace(/\.json$/i, "");
    const file = path.join(outDir, `${base}.${name}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2), "utf8");
    rows.push({
      strategy: name,
      total: report.estimated.resentInputTokens,
      peak: report.estimated.peakInputTokens,
      trims: report.sideEffects.contextTrims,
    });
    console.log(`  写入 ${file}`);
  }

  const baseline = rows.find((row) => row.strategy === "legacy")?.total;
  console.log(`\nfixture: ${path.basename(fixturePath)}  消息 ${messages.length}  轮次 ${rows.length > 0 ? "见报告" : 0}`);
  console.log(`固定开销/轮: system ${fixed.systemTokens} + tools ${fixed.toolSchemaTokens} = ${fixed.systemTokens + fixed.toolSchemaTokens} tokens`);
  console.log("\n策略           估算重传输入        峰值      裁剪次数   相对 legacy");
  for (const row of rows) {
    const delta = baseline && baseline > 0 && row.strategy !== "legacy"
      ? `${((1 - row.total / baseline) * 100).toFixed(1)}%`
      : "—";
    console.log(
      `${row.strategy.padEnd(12)} ${row.total.toLocaleString().padStart(16)} ` +
      `${row.peak.toLocaleString().padStart(10)} ${String(row.trims).padStart(10)} ${delta.padStart(12)}`,
    );
  }
  console.log("\n⚠ 以上为离线启发式估算，不是 Provider 账单。");
}

const invokedDirectly = process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
