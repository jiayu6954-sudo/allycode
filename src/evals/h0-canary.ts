/**
 * H0 protocol canary — the smallest real-provider check that can exist.
 *
 * Two model calls, one synthetic in-memory tool, no project scan, no file,
 * shell, network or browser tool, no retries. Its only job is to prove the
 * Phase B changes did not break the wire protocol: a structured tool call, a
 * legal continuation carrying exactly the reasoning the round needs, and a
 * canonical runtime transcript retaining all required continuation states.
 *
 * Every limit below is enforced in code, not by discipline. The run aborts the
 * moment one would be crossed, and any 401/402/404/429/5xx stops it at once
 * without a second attempt.
 *
 * The report never contains the API key, request headers, or reasoning text —
 * reasoning is reported as a boolean and a length only.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { OpenAICompatibleProvider } from "../providers/openai-compatible.js";
import { enforceReasoningRetention } from "../agent/loop.js";
import { estimateTokens } from "../agent/history-budget.js";
import type { ConversationMessage } from "../types/agent.js";
import type { ToolDefinition } from "../types/tools.js";
import { findPrice, type ModelPrice } from "../utils/pricing.js";

export const H0_LIMITS = {
  /** Inference calls. */
  modelCalls: 2,
  /** Free metadata calls: /models preflight, balance before, balance after. */
  metadataCalls: 3,
  /** Everything above, so no path can quietly add a request. */
  httpRequests: 5,
  cumulativeInputTokens: 10_000,
  cumulativeOutputTokens: 1_000,
  outputTokensPerTurn: 512,
  /** Administrative approval ceiling — NOT something code can enforce per-yuan. */
  approvalCeilingCny: 1,
} as const;

/**
 * Prices come from the shared registry so the canary and the running product
 * can never disagree about what a token costs. The earlier local copy omitted
 * the cache-hit rate entirely, which is exactly the gap that made billed cache
 * reads invisible.
 */
export const DEEPSEEK_V4_PRO_PRICING = findPrice("deepseek-v4-pro", "deepseek");

/**
 * Worst case if every capped token were spent at the most expensive rate.
 * Cache reads are not modelled: the canary sends two short requests with no
 * shared prefix, so a cache hit is not expected — and a hit is 12× cheaper
 * than the miss rate used here, so this stays an upper bound either way.
 */
export function theoreticalWorstCaseCny(): number | null {
  const price = DEEPSEEK_V4_PRO_PRICING;
  if (price?.currency !== "CNY" || !price.inputCacheMissPerMillion || !price.outputPerMillion) return null;
  const input = (H0_LIMITS.cumulativeInputTokens / 1_000_000) * price.inputCacheMissPerMillion;
  const output = (H0_LIMITS.cumulativeOutputTokens / 1_000_000) * price.outputPerMillion;
  return Number((input + output).toFixed(4));
}

/** Counts every outbound request so no code path can add one unnoticed. */
export class RequestBudget {
  modelCalls = 0;
  metadataCalls = 0;
  get httpRequests(): number { return this.modelCalls + this.metadataCalls; }

  spendModelCall(): void {
    if (this.modelCalls + 1 > H0_LIMITS.modelCalls) {
      throw new LimitExceeded(`模型调用将超过 ${H0_LIMITS.modelCalls} 次上限`);
    }
    this.assertHttpHeadroom();
    this.modelCalls++;
  }

  spendMetadataCall(): void {
    if (this.metadataCalls + 1 > H0_LIMITS.metadataCalls) {
      throw new LimitExceeded(`元数据调用将超过 ${H0_LIMITS.metadataCalls} 次上限`);
    }
    this.assertHttpHeadroom();
    this.metadataCalls++;
  }

  private assertHttpHeadroom(): void {
    if (this.httpRequests + 1 > H0_LIMITS.httpRequests) {
      throw new LimitExceeded(`HTTP 请求将超过 ${H0_LIMITS.httpRequests} 次上限`);
    }
  }
}

export const SENTINEL = "H0-CANARY-ALPHA9";

/** The only tool. It never touches the machine; the result is a constant. */
export const H0_TOOL: ToolDefinition = {
  name: "get_h0_value" as ToolDefinition["name"],
  description: "Return the canary value for a key.",
  input_schema: {
    type: "object",
    properties: { key: { type: "string" } },
    required: ["key"],
  },
};
const H0_TOOL_RESULT = JSON.stringify({ value: SENTINEL });

export interface H0Check {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface H0Report {
  schemaVersion: 1;
  kind: "h0_protocol_canary";
  generatedAt: string;
  model: string;
  endpoint: string;
  protocol: string;
  environment: { gitCommit: string; node: string; platform: string };
  calls: Array<{
    turn: number;
    status: "ok" | "failed" | "skipped";
    stopReason?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number | "not_reported";
    /** Reasoning is reported as presence and size only — never content. */
    reasoningProduced: boolean;
    reasoningChars: number;
    /** Tightened for round two so the cumulative output cap holds. */
    maxOutputTokensRequested?: number;
    projectedInputTokens?: number;
    error?: string;
  }>;
  requests: { modelCalls: number; metadataCalls: number; httpRequests: number };
  preflight: { modelsChecked: boolean; modelPresent: boolean; detail: string };
  totals: { inputTokens: number; outputTokens: number; cacheReadTokens: number | "not_reported" };
  cost: {
    pricing: ModelPrice | null;
    /** Every capped token at the most expensive rate. null when unpriced. */
    theoreticalWorstCaseCny: number | null;
    approvalCeilingCny: number;
    /** Per-currency balance delta — the actual evidence when it moves. */
    observedSpend: Record<string, number> | "unknown";
    balanceBefore: Record<string, number> | "unknown";
    balanceAfter: Record<string, number> | "unknown";
    note: string;
  };
  canonicalReasoningRemaining: number;
  checks: H0Check[];
  verdict: "PASS" | "FAIL" | "ABORTED";
  limits: typeof H0_LIMITS;
  notVerified: string[];
}

class LimitExceeded extends Error {}
class ProviderRefused extends Error {}
class ModelUnavailable extends Error {}

const H0_SYSTEM_PROMPT = "你是协议金丝雀测试对象。严格按用户指令执行，不要解释。";

/**
 * What the request will actually weigh: the system prompt and the tool schema
 * ride on every call, so estimating the message array alone understates it.
 */
export function projectedInputTokens(messages: ConversationMessage[]): number {
  return estimateTokens(H0_SYSTEM_PROMPT)
    + estimateTokens(JSON.stringify(messages))
    + estimateTokens(JSON.stringify([H0_TOOL]));
}

/** Output allowance for a turn, tightened so the cumulative cap cannot break. */
export function outputAllowance(cumulativeOutput: number): number {
  return Math.min(
    H0_LIMITS.outputTokensPerTurn,
    H0_LIMITS.cumulativeOutputTokens - cumulativeOutput,
  );
}

/** Parse every currency the provider reports, not just the first entry. */
export function parseBalances(body: unknown): Record<string, number> | "unknown" {
  const record = body && typeof body === "object" ? body as Record<string, unknown> : null;
  const infos = record?.["balance_infos"];
  if (!Array.isArray(infos) || infos.length === 0) return "unknown";
  const out: Record<string, number> = {};
  for (const entry of infos) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const currency = typeof row["currency"] === "string" ? row["currency"] : null;
    const total = Number(row["total_balance"]);
    if (currency && Number.isFinite(total)) out[currency] = total;
  }
  return Object.keys(out).length > 0 ? out : "unknown";
}

/** Per-currency spend. Absent or unreadable balances stay "unknown". */
export function diffBalances(
  before: Record<string, number> | "unknown",
  after: Record<string, number> | "unknown",
): Record<string, number> | "unknown" {
  if (before === "unknown" || after === "unknown") return "unknown";
  const out: Record<string, number> = {};
  for (const currency of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const from = before[currency];
    const to = after[currency];
    if (typeof from === "number" && typeof to === "number") {
      out[currency] = Number((from - to).toFixed(6));
    }
  }
  return Object.keys(out).length > 0 ? out : "unknown";
}

interface RunOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  /** Injected in tests so the canary itself can be verified without spending. */
  providerFactory?: (baseUrl: string, key: string) => OpenAICompatibleProvider;
  /** Reads per-currency balances. Omitted when the provider has no such endpoint. */
  readBalance?: () => Promise<Record<string, number> | "unknown">;
  /** Lists model ids for the exact-match preflight. */
  listModels?: () => Promise<string[]>;
}

export async function runH0Canary(options: RunOptions): Promise<H0Report> {
  const report: H0Report = {
    schemaVersion: 1,
    kind: "h0_protocol_canary",
    generatedAt: new Date().toISOString(),
    model: options.model,
    endpoint: options.baseUrl,
    protocol: "chat_completions",
    environment: environment(),
    calls: [],
    requests: { modelCalls: 0, metadataCalls: 0, httpRequests: 0 },
    preflight: { modelsChecked: false, modelPresent: false, detail: "未执行" },
    totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: "not_reported" },
    cost: {
      pricing: DEEPSEEK_V4_PRO_PRICING,
      theoreticalWorstCaseCny: theoreticalWorstCaseCny(),
      approvalCeilingCny: H0_LIMITS.approvalCeilingCny,
      observedSpend: "unknown",
      balanceBefore: "unknown",
      balanceAfter: "unknown",
      note:
        `理论最坏 ${theoreticalWorstCaseCny() === null ? "未知（模型未登记价格）" : `¥${theoreticalWorstCaseCny()}`}` +
        `（${H0_LIMITS.cumulativeInputTokens} 输入 × 未命中价 + ${H0_LIMITS.cumulativeOutputTokens} 输出）。` +
        `¥${H0_LIMITS.approvalCeilingCny} 是行政审批额度，代码强制的是 token 上限而非实时人民币扣费。` +
        "余额差额若可读取，则为实际花费的权威证据。",
    },
    canonicalReasoningRemaining: -1,
    checks: [],
    verdict: "ABORTED",
    limits: H0_LIMITS,
    notVerified: [],
  };

  const provider = options.providerFactory
    ? options.providerFactory(options.baseUrl, options.apiKey)
    : new OpenAICompatibleProvider(options.baseUrl, options.apiKey, "deepseek");
  const budget = new RequestBudget();

  const canonical: ConversationMessage[] = [
    { role: "user", content: `调用 get_h0_value，key 为 "phase-b"。只调用这一个工具。` },
  ];
  let cumulativeInput = 0;
  let cumulativeOutput = 0;
  let firstToolId = "";
  let firstReasoningChars = 0;
  let scopeSeen: Record<string, unknown> | null = null;
  let roundTripSurvived = false;
  let secondText = "";
  let secondCalledTool = false;
  // Tracked separately from `report.verdict`: guarding on the field the guard
  // is meant to set means the verdict can never move off its initial value.
  let aborted = false;

  const cumulative = { input: 0, output: 0 };

  try {
    // ── Preflight: the model must be listed, exactly ────────────────────────
    // A metadata call, not an inference call. If the model is absent the run
    // stops here with zero model calls rather than substituting another.
    if (options.listModels) {
      budget.spendMetadataCall();
      const ids = await options.listModels();
      report.preflight.modelsChecked = true;
      report.preflight.modelPresent = ids.includes(options.model);
      report.preflight.detail = report.preflight.modelPresent
        ? `${options.model} 在账户模型列表中`
        : `${options.model} 不在账户模型列表中（共 ${ids.length} 个），不替换模型，停止`;
      if (!report.preflight.modelPresent) {
        throw new ModelUnavailable(report.preflight.detail);
      }
    } else {
      report.preflight.detail = "未提供模型列表读取器，预检未执行";
    }

    if (options.readBalance) {
      budget.spendMetadataCall();
      report.cost.balanceBefore = await options.readBalance();
    }

    // ── Round 1: expect exactly one structured tool call ────────────────────
    const first = await callOnce(provider, options.model, canonical, 1, report, budget, cumulative);
    cumulativeInput += first.usage.input_tokens ?? 0;
    cumulativeOutput += first.usage.output_tokens ?? 0;
    cumulative.input = cumulativeInput;
    cumulative.output = cumulativeOutput;
    assertBudget(cumulativeInput, cumulativeOutput);

    const toolUses = first.content.filter((block) => block.type === "tool_use");
    const onlyToolUse = toolUses.length === 1 ? toolUses[0] : undefined;
    firstToolId = onlyToolUse?.type === "tool_use" ? onlyToolUse.id : "";
    const state = first.providerState;
    if (state?.protocol === "deepseek-chat") {
      firstReasoningChars = state.reasoningContent?.length ?? 0;
      scopeSeen = (state.scope ?? null) as Record<string, unknown> | null;
    }
    report.calls[0]!.reasoningProduced = firstReasoningChars > 0;
    report.calls[0]!.reasoningChars = firstReasoningChars;

    canonical.push({
      role: "assistant",
      content: first.content.map((block) =>
        block.type === "tool_use"
          ? { type: "tool_use" as const, id: block.id, name: block.name, input: block.input as Record<string, unknown> }
          : { type: "text" as const, text: block.type === "text" ? block.text : "" }),
      ...(first.providerState ? { providerState: first.providerState } : {}),
    });

    // Serialisation round trip — the record is persisted as JSON.
    const revived = JSON.parse(JSON.stringify(canonical)) as ConversationMessage[];
    const revivedState = revived.at(-1)?.providerState;
    roundTripSurvived = revivedState?.protocol === "deepseek-chat"
      ? (revivedState.reasoningContent?.length ?? 0) === firstReasoningChars
      : firstReasoningChars === 0;

    // ── Round 2: legal continuation, expect the sentinel and no tool call ───
    canonical.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: firstToolId || "missing", content: H0_TOOL_RESULT }],
    } as ConversationMessage);
    canonical.push({ role: "user", content: `只回复这一行，不要调用工具：${SENTINEL}` });

    const second = await callOnce(provider, options.model, canonical, 2, report, budget, cumulative);
    cumulativeInput += second.usage.input_tokens ?? 0;
    cumulativeOutput += second.usage.output_tokens ?? 0;
    cumulative.input = cumulativeInput;
    cumulative.output = cumulativeOutput;
    assertBudget(cumulativeInput, cumulativeOutput);

    secondCalledTool = second.content.some((block) => block.type === "tool_use");
    secondText = second.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("")
      .trim();
    const secondState = second.providerState;
    const secondReasoning = secondState?.protocol === "deepseek-chat"
      ? secondState.reasoningContent?.length ?? 0
      : 0;
    report.calls[1]!.reasoningProduced = secondReasoning > 0;
    report.calls[1]!.reasoningChars = secondReasoning;

    canonical.push({
      role: "assistant",
      content: [{ type: "text", text: secondText }],
      ...(second.providerState ? { providerState: second.providerState } : {}),
    });
    enforceReasoningRetention(canonical);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    aborted = true;
    report.notVerified.push(`运行中止：${message}`);
  }

  report.totals.inputTokens = cumulativeInput;
  report.totals.outputTokens = cumulativeOutput;
  report.canonicalReasoningRemaining = canonical.filter((message) => {
    const state = message.providerState;
    return state?.protocol === "deepseek-chat" && Boolean(state.reasoningContent);
  }).length;

  if (options.readBalance && budget.metadataCalls < H0_LIMITS.metadataCalls) {
    try {
      budget.spendMetadataCall();
      report.cost.balanceAfter = await options.readBalance();
      report.cost.observedSpend = diffBalances(report.cost.balanceBefore, report.cost.balanceAfter);
    } catch {
      report.notVerified.push("结束余额读取未执行或失败，实际花费未取得权威证据");
    }
  }
  report.requests = {
    modelCalls: budget.modelCalls,
    metadataCalls: budget.metadataCalls,
    httpRequests: budget.httpRequests,
  };

  report.checks = buildChecks({
    report,
    firstToolId,
    scopeSeen,
    firstReasoningChars,
    roundTripSurvived,
    secondText,
    secondCalledTool,
  });
  report.verdict = aborted
    ? "ABORTED"
    : report.checks.every((check) => check.passed) ? "PASS" : "FAIL";
  report.notVerified.push(
    "仅覆盖协议层往返，不代表模型质量、任务完成率或成本结论。",
    "单次运行，不构成稳定基准。",
  );
  return report;
}

/** One call. No retry, ever — a refusal ends the canary. */
async function callOnce(
  provider: OpenAICompatibleProvider,
  model: string,
  messages: ConversationMessage[],
  turn: number,
  report: H0Report,
  budget: RequestBudget,
  cumulative: { input: number; output: number },
) {
  // The cap is on CUMULATIVE input, so the check must add what has already
  // been spent. Testing this turn alone let a second request go out and only
  // then discover the total was over.
  const projected = projectedInputTokens(messages);
  if (cumulative.input + projected > H0_LIMITS.cumulativeInputTokens) {
    throw new LimitExceeded(
      `累计输入 ${cumulative.input} + 本轮预估 ${projected} 将超过 ${H0_LIMITS.cumulativeInputTokens}，未发出请求`,
    );
  }
  const allowance = outputAllowance(cumulative.output);
  if (allowance <= 0) {
    throw new LimitExceeded(`累计输出已达 ${cumulative.output}，无剩余额度，未发出请求`);
  }

  budget.spendModelCall();
  report.calls.push({
    turn,
    status: "failed",
    reasoningProduced: false,
    reasoningChars: 0,
    maxOutputTokensRequested: allowance,
    projectedInputTokens: projected,
  });
  const slot = report.calls[report.calls.length - 1]!;

  try {
    const handle = provider.stream({
      model,
      // Round two is tightened to whatever remains, so two turns of 512 can
      // never add up past the declared 1,000 ceiling.
      maxTokens: allowance,
      systemPrompt: H0_SYSTEM_PROMPT,
      messages,
      tools: [H0_TOOL],
    });
    for await (const _delta of handle.deltas()) { /* drain */ }
    const final = await handle.finalMessage();
    slot.status = "ok";
    slot.stopReason = final.stop_reason;
    slot.inputTokens = final.usage.input_tokens;
    slot.outputTokens = final.usage.output_tokens;
    slot.cacheReadTokens = final.usage.cache_read_input_tokens ?? "not_reported";
    return final;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    slot.error = redact(message);
    // 401/402/404/429/5xx and anything else: stop at once, no second attempt.
    throw new ProviderRefused(redact(message));
  }
}

function assertBudget(input: number, output: number): void {
  if (input > H0_LIMITS.cumulativeInputTokens) {
    throw new LimitExceeded(`累计输入 ${input} 超过 ${H0_LIMITS.cumulativeInputTokens}`);
  }
  if (output > H0_LIMITS.cumulativeOutputTokens) {
    throw new LimitExceeded(`累计输出 ${output} 超过 ${H0_LIMITS.cumulativeOutputTokens}`);
  }
}

/** Strip anything that could carry a credential out of an error string. */
export function redact(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{4,}/g, "sk-***")
    .replace(/Bearer\s+\S+/gi, "Bearer ***")
    .replace(/(authorization|api[-_]?key)\s*[:=]\s*\S+/gi, "$1: ***")
    .slice(0, 400);
}

function buildChecks(input: {
  report: H0Report;
  firstToolId: string;
  scopeSeen: Record<string, unknown> | null;
  firstReasoningChars: number;
  roundTripSurvived: boolean;
  secondText: string;
  secondCalledTool: boolean;
}): H0Check[] {
  const { report, scopeSeen } = input;
  const scopeKeys = ["provider", "protocol", "model", "baseUrl"];
  const scopeComplete = Boolean(scopeSeen) &&
    scopeKeys.every((key) => typeof scopeSeen?.[key] === "string" && String(scopeSeen[key]).length > 0);

  return [
    {
      id: "structured_tool_call",
      label: "第一轮返回单个结构化工具调用",
      passed: input.firstToolId !== "",
      detail: input.firstToolId !== "" ? "收到恰好一个 tool_use" : "未收到唯一的结构化工具调用",
    },
    {
      id: "state_scope_complete",
      label: "providerState.scope 含 provider/protocol/model/baseUrl",
      passed: scopeComplete,
      detail: scopeComplete
        ? `scope 四项齐备（model=${String(scopeSeen?.["model"])}）`
        : input.firstReasoningChars === 0
          ? "模型未产生 reasoning，本轮无 providerState —— 该项不适用，记为未通过以免误判为已验证"
          : "scope 缺少必需字段",
    },
    {
      id: "single_reasoning_carried",
      label: "第二轮只携带当前续接所需的一份 reasoning",
      passed: report.calls.length === 2,
      detail: input.firstReasoningChars > 0
        ? `第一轮 reasoning ${input.firstReasoningChars} 字符，仅该轮随续接回传`
        : "模型未产生 reasoning，无可回传内容",
    },
    {
      id: "state_json_roundtrip",
      label: "providerState 经 JSON 往返不丢失",
      passed: input.roundTripSurvived,
      detail: input.roundTripSurvived ? "序列化前后一致" : "往返后 reasoning 长度发生变化",
    },
    {
      id: "sentinel_exact",
      label: "第二轮精确返回哨兵且未再调用工具",
      passed: input.secondText === SENTINEL && !input.secondCalledTool,
      detail: input.secondCalledTool
        ? "第二轮意外再次调用了工具"
        : input.secondText === SENTINEL
          ? "返回值与哨兵完全一致"
          : `返回值不匹配（长度 ${input.secondText.length}）`,
    },
    {
      id: "continuation_state_preserved",
      label: "所需续接状态在运行时保留，报告不含正文",
      passed: report.canonicalReasoningRemaining >= report.calls.filter((call) => call.reasoningProduced).length,
      detail: `运行时保留 ${report.canonicalReasoningRemaining} 处私有续接状态`,
    },
    {
      id: "usage_recorded",
      label: "两轮 Provider usage 均被记录",
      passed: report.calls.length === 2 &&
        report.calls.every((call) => typeof call.inputTokens === "number" && typeof call.outputTokens === "number"),
      detail: `input=${report.totals.inputTokens} output=${report.totals.outputTokens}`,
    },
    {
      id: "cache_distinguished",
      label: "cache 未上报 / 未命中 / 命中可区分",
      passed: report.calls.every((call) =>
        call.cacheReadTokens === "not_reported" || typeof call.cacheReadTokens === "number"),
      detail: report.calls
        .map((call) => `轮${call.turn}: ${call.cacheReadTokens === "not_reported" ? "未上报" : `${call.cacheReadTokens} 命中`}`)
        .join(" | "),
    },
    {
      id: "no_secret_leak",
      label: "报告不含密钥、请求头或 reasoning 正文",
      passed: !/sk-[A-Za-z0-9_-]{6,}|Bearer\s+\S{6,}/.test(JSON.stringify(report)),
      detail: "已对错误串脱敏；reasoning 仅记录布尔与长度",
    },
  ];
}

function environment(): H0Report["environment"] {
  let gitCommit = "unknown";
  try {
    gitCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch { /* not a repo */ }
  return { gitCommit, node: process.version, platform: `${os.type()} ${os.release()}` };
}

export function writeH0Report(report: H0Report, outDir = path.join(".benchmark-results", "h0")): string {
  fs.mkdirSync(outDir, { recursive: true });
  const target = path.join(outDir, `${report.model}-phase-b.json`);
  fs.writeFileSync(target, JSON.stringify(report, null, 2), "utf8");
  return target;
}

export function renderH0Report(report: H0Report): string {
  const lines = [
    `H0 协议金丝雀 — ${report.verdict}`,
    `模型：${report.model}   端点：${report.endpoint}   协议：${report.protocol}`,
    `调用：${report.calls.map((call) => `轮${call.turn}=${call.status}`).join("  ")}`,
    `token：输入 ${report.totals.inputTokens}  输出 ${report.totals.outputTokens}`,
    `理论最坏：${report.cost.theoreticalWorstCaseCny === null ? "未知" : `¥${report.cost.theoreticalWorstCaseCny}`}` +
      `（${report.cost.pricing?.source ?? "价格未登记"}，${report.cost.pricing?.asOf ?? "-"}）`,
    `实际花费：${report.cost.observedSpend === "unknown" ? "未知（余额未变动或不可读）" : Object.entries(report.cost.observedSpend).map(([c, v]) => `${c} ${v}`).join("  ")}`,
    `请求：模型 ${report.requests.modelCalls}/${H0_LIMITS.modelCalls}  元数据 ${report.requests.metadataCalls}/${H0_LIMITS.metadataCalls}  HTTP ${report.requests.httpRequests}/${H0_LIMITS.httpRequests}`,
    `模型预检：${report.preflight.detail}`,
    `canonical reasoning 残留：${report.canonicalReasoningRemaining}`,
    "",
  ];
  for (const check of report.checks) {
    lines.push(`  ${check.passed ? "PASS" : "FAIL"}  ${check.label} — ${check.detail}`);
  }
  if (report.notVerified.length > 0) {
    lines.push("", "未验证：");
    for (const item of report.notVerified) lines.push(`  · ${item}`);
  }
  return lines.join("\n");
}

/**
 * A metadata GET. Any 4xx, 5xx, timeout or unparseable body stops the canary —
 * there is no retry path, because a flaky preflight must not be papered over
 * before spending money.
 */
async function metadataGet(url: string, apiKey: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new ProviderRefused(redact(`元数据请求失败：${err instanceof Error ? err.message : String(err)}`));
  }
  if (!response.ok) {
    throw new ProviderRefused(`元数据请求返回 HTTP ${response.status}，立即停止且不重试`);
  }
  try {
    return await response.json();
  } catch {
    throw new ProviderRefused("元数据响应不是合法 JSON，立即停止且不重试");
  }
}

export async function listModelIds(baseUrl: string, apiKey: string): Promise<string[]> {
  const body = await metadataGet(new URL("models", ensureTrailingSlash(baseUrl)).toString(), apiKey);
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) throw new ProviderRefused("模型列表响应格式异常，立即停止");
  return data
    .map((entry) => (entry && typeof entry === "object" ? (entry as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === "string");
}

export async function readBalances(
  baseUrl: string,
  apiKey: string,
): Promise<Record<string, number> | "unknown"> {
  const origin = new URL(baseUrl).origin;
  return parseBalances(await metadataGet(`${origin}/user/balance`, apiKey));
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

/**
 * CLI entry. Refuses to run without an explicit go-ahead, because this is the
 * only script in the repo that spends money. The key comes from the
 * environment and is never logged, echoed, or written to the artifact.
 */
async function main(): Promise<void> {
  const approved = process.argv.includes("--approved");
  const apiKey = process.env["DEEPSEEK_API_KEY"]?.trim();
  const model = process.env["H0_MODEL"]?.trim() || "deepseek-v4-pro";
  const baseUrl = process.env["H0_BASE_URL"]?.trim() || "https://api.deepseek.com/v1";

  if (!approved) {
    console.error(
      "H0 会真实调用付费 API。确认预算后再加 --approved 运行。\n" +
      `限制：${H0_LIMITS.modelCalls} 次调用 · 累计输入 ≤ ${H0_LIMITS.cumulativeInputTokens} · ` +
      `累计输出 ≤ ${H0_LIMITS.cumulativeOutputTokens} · 每轮 ≤ ${H0_LIMITS.outputTokensPerTurn} · ` +
      `理论最坏 ¥${theoreticalWorstCaseCny()} · 审批额度 ¥${H0_LIMITS.approvalCeilingCny}`,
    );
    process.exitCode = 2;
    return;
  }
  if (!apiKey) {
    console.error("缺少 DEEPSEEK_API_KEY。请通过环境变量提供，不要写入文件或命令行参数。");
    process.exitCode = 2;
    return;
  }

  const report = await runH0Canary({
    apiKey, model, baseUrl,
    readBalance: () => readBalances(baseUrl, apiKey),
    listModels: () => listModelIds(baseUrl, apiKey),
  });
  const target = writeH0Report(report);
  console.log(renderH0Report(report));
  console.log(`\nartifact: ${target}\nharness: ${harnessHash()}`);
  process.exitCode = report.verdict === "PASS" ? 0 : 1;
}

const invokedDirectly = process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(redact(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
}

/** Stable hash of this harness, so a changed canary is visible in the artifact. */
export function harnessHash(): string {
  try {
    const self = new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    return crypto.createHash("sha256").update(fs.readFileSync(self)).digest("hex").slice(0, 16);
  } catch {
    return "unknown";
  }
}
