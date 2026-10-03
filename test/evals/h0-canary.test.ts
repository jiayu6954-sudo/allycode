import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  H0_LIMITS,
  SENTINEL,
  diffBalances,
  outputAllowance,
  parseBalances,
  redact,
  renderH0Report,
  runH0Canary,
} from "../../src/evals/h0-canary.js";
import type { OpenAICompatibleProvider } from "../../src/providers/openai-compatible.js";
import type { NormalizedMessage, ProviderStreamHandle, StreamOptions } from "../../src/providers/interface.js";
import type { ConversationMessage } from "../../src/types/agent.js";

/**
 * The canary spends real money, so it gets verified offline first. A fake
 * provider stands in for DeepSeek and records exactly what would go on the
 * wire, which is how the request-shape checks are proved without a request.
 */

const SCOPE = {
  provider: "deepseek",
  protocol: "chat_completions" as const,
  model: "deepseek-v4-pro",
  baseUrl: "https://api.deepseek.com/v1",
};

interface FakeOptions {
  reasoning?: string;
  secondText?: string;
  secondCallsTool?: boolean;
  failOnTurn?: number;
  failWith?: string;
  outputTokens?: number;
  firstInputTokens?: number;
}

function fakeProvider(sent: StreamOptions[], options: FakeOptions = {}) {
  let round = 0;
  return () => ({
    stream(streamOptions: StreamOptions): ProviderStreamHandle {
      // Snapshot at call time. The canary passes its canonical array by
      // reference and mutates it afterwards, so storing the reference would
      // record the end state rather than what was actually sent.
      sent.push({
        ...streamOptions,
        messages: JSON.parse(JSON.stringify(streamOptions.messages)) as ConversationMessage[],
      });
      round++;
      if (options.failOnTurn === round) {
        throw new Error(options.failWith ?? "HTTP 402 Insufficient Balance");
      }
      const final: NormalizedMessage = round === 1
        ? {
            stop_reason: "tool_use",
            content: [{ type: "tool_use", id: "call_h0", name: "get_h0_value", input: { key: "phase-b" } }],
            usage: { input_tokens: options.firstInputTokens ?? 120, output_tokens: Math.min(options.outputTokens ?? 24, streamOptions.maxTokens) },
            ...(options.reasoning
              ? { providerState: { protocol: "deepseek-chat" as const, scope: SCOPE, reasoningContent: options.reasoning } }
              : {}),
          }
        : {
            stop_reason: "end_turn",
            content: options.secondCallsTool
              ? [{ type: "tool_use", id: "call_again", name: "get_h0_value", input: { key: "phase-b" } }]
              : [{ type: "text", text: options.secondText ?? SENTINEL }],
            usage: { input_tokens: 210, output_tokens: Math.min(options.outputTokens ?? 12, streamOptions.maxTokens), cache_read_input_tokens: 64 },
          };
      return {
        async *deltas() { yield { type: "text" as const, text: "" }; },
        finalMessage: async () => final,
      } as unknown as ProviderStreamHandle;
    },
  }) as unknown as OpenAICompatibleProvider;
}

async function run(options: FakeOptions = {}, readBalance?: () => Promise<Record<string, number> | "unknown">) {
  const sent: StreamOptions[] = [];
  const report = await runH0Canary({
    apiKey: "sk-should-never-appear",
    model: "deepseek-v4-pro",
    baseUrl: SCOPE.baseUrl,
    providerFactory: fakeProvider(sent, options),
    ...(readBalance ? { readBalance } : {}),
  });
  return { report, sent };
}

const reasoningIn = (messages: ConversationMessage[]): number =>
  messages.filter((message) => {
    const state = message.providerState;
    return state?.protocol === "deepseek-chat" && Boolean(state.reasoningContent);
  }).length;

describe("H0 canary harness", () => {
  it("passes on a well-behaved two-round exchange", async () => {
    const { report, sent } = await run({ reasoning: "内部思考".repeat(20) });

    expect(report.verdict).toBe("PASS");
    expect(sent).toHaveLength(2);
    expect(report.calls.map((call) => call.status)).toEqual(["ok", "ok"]);
    for (const check of report.checks) expect(check.passed, check.label).toBe(true);
  });

  it("makes exactly two model calls and offers exactly one tool", async () => {
    const { sent } = await run({ reasoning: "思考" });

    expect(sent).toHaveLength(2);
    for (const call of sent) {
      expect(call.tools).toHaveLength(1);
      expect(call.tools[0]?.name).toBe("get_h0_value");
      expect(call.maxTokens).toBe(H0_LIMITS.outputTokensPerTurn);
    }
  });

  it("carries the tool call, its reasoning and the tool_result into round two", async () => {
    const { sent } = await run({ reasoning: "第一轮思考" });

    const secondRequest = sent[1]!.messages;
    expect(reasoningIn(secondRequest)).toBe(1);
    const flattened = JSON.stringify(secondRequest);
    expect(flattened).toContain("call_h0");
    expect(flattened).toContain(SENTINEL); // the tool result body
  });

  it("retains required runtime continuation state after the tool round", async () => {
    const { report } = await run({ reasoning: "思考".repeat(50) });
    expect(report.canonicalReasoningRemaining).toBe(1);
    expect(report.calls[0]?.reasoningProduced).toBe(true);
    expect(report.calls[0]?.reasoningChars).toBe(100);
  });

  it("fails rather than passes when the sentinel does not match", async () => {
    const { report } = await run({ reasoning: "思考", secondText: "H0-CANARY-WRONG" });

    expect(report.verdict).toBe("FAIL");
    expect(report.checks.find((check) => check.id === "sentinel_exact")?.passed).toBe(false);
  });

  it("fails when the second round calls a tool again", async () => {
    const { report } = await run({ reasoning: "思考", secondCallsTool: true });

    expect(report.verdict).toBe("FAIL");
    expect(report.checks.find((check) => check.id === "sentinel_exact")?.detail).toContain("再次调用");
  });

  it("stops at the first provider refusal without a retry", async () => {
    const sent: StreamOptions[] = [];
    const report = await runH0Canary({
      apiKey: "sk-x",
      model: "deepseek-v4-pro",
      baseUrl: SCOPE.baseUrl,
      providerFactory: fakeProvider(sent, { failOnTurn: 1, failWith: "HTTP 402 Insufficient Balance" }),
    });

    expect(sent).toHaveLength(1); // one attempt, never two
    expect(report.verdict).toBe("ABORTED");
    expect(report.calls[0]?.status).toBe("failed");
    expect(report.notVerified.join(" ")).toContain("402");
  });

  it("holds the output cap by tightening rather than by aborting", async () => {
    // A model that would happily emit 900 per turn is capped to 512 then 488.
    // Before round two was tightened this overshot to 1,024.
    const { report, sent } = await run({ reasoning: "思考", outputTokens: 900 });

    expect(sent[0]?.maxTokens).toBe(512);
    expect(sent[1]?.maxTokens).toBe(488);
    expect(report.totals.outputTokens).toBe(H0_LIMITS.cumulativeOutputTokens);
    expect(report.verdict).toBe("PASS");
  });

  it("aborts before a request when no output allowance remains", async () => {
    expect(outputAllowance(0)).toBe(512);
    expect(outputAllowance(512)).toBe(488);
    expect(outputAllowance(H0_LIMITS.cumulativeOutputTokens)).toBe(0);
    // A zero allowance must stop the call rather than send maxTokens: 0.
    expect(outputAllowance(H0_LIMITS.cumulativeOutputTokens + 10)).toBeLessThan(0);
  });

  it("distinguishes cache not reported from cache hits", async () => {
    const { report } = await run({ reasoning: "思考" });

    expect(report.calls[0]?.cacheReadTokens).toBe("not_reported");
    expect(report.calls[1]?.cacheReadTokens).toBe(64);
    expect(report.checks.find((check) => check.id === "cache_distinguished")?.passed).toBe(true);
  });

  it("reports spend from the balance delta and never invents a price", async () => {
    let call = 0;
    const balances: Array<Record<string, number>> = [{ CNY: 12.5 }, { CNY: 12.4863 }];
    const { report } = await run({ reasoning: "思考" }, async () => balances[call++]!);

    expect(report.cost.balanceBefore).toEqual({ CNY: 12.5 });
    expect(report.cost.observedSpend).toEqual({ CNY: 0.0137 });
    // The published price is stated; the balance delta is the actual evidence.
    expect(report.cost.theoreticalWorstCaseCny).toBeNull();
  });

  it("says unknown rather than zero when the balance cannot be read", async () => {
    const { report } = await run({ reasoning: "思考" });
    expect(report.cost.observedSpend).toBe("unknown");
  });

  it("never leaks the key, headers or reasoning text into the report", async () => {
    const { report } = await run({ reasoning: "这是绝不能出现在报告里的思维链内容" });
    const serialized = JSON.stringify(report) + renderH0Report(report);

    expect(serialized).not.toContain("sk-should-never-appear");
    expect(serialized).not.toContain("这是绝不能出现在报告里的思维链内容");
    expect(serialized).not.toMatch(/Bearer\s+\S{6,}/);
    expect(report.checks.find((check) => check.id === "no_secret_leak")?.passed).toBe(true);
  });

  it("redacts credentials out of provider error strings", () => {
    expect(redact("401 for key sk-abcdef123456 via Bearer sk-abcdef123456"))
      .not.toMatch(/sk-abcdef123456/);
    expect(redact("authorization: sk-zzzzzzzzzz")).toContain("***");
  });

  it("makes zero model calls when the cumulative INPUT cap would break", async () => {
    // The cap is cumulative, so a first round that nearly fills it must stop
    // the second BEFORE the request goes out — not after it returns.
    const sent: StreamOptions[] = [];
    const report = await runH0Canary({
      apiKey: "sk-x",
      model: "deepseek-v4-pro",
      baseUrl: SCOPE.baseUrl,
      providerFactory: fakeProvider(sent, { reasoning: "思考", firstInputTokens: 9_990 }),
    });

    expect(sent).toHaveLength(1); // the second request was never sent
    expect(report.requests.modelCalls).toBe(1);
    expect(report.verdict).toBe("ABORTED");
    expect(report.notVerified.join(" ")).toMatch(/累计输入/);
  });

  it("tightens round two so cumulative output cannot exceed the cap", async () => {
    const sent: StreamOptions[] = [];
    const report = await runH0Canary({
      apiKey: "sk-x",
      model: "deepseek-v4-pro",
      baseUrl: SCOPE.baseUrl,
      providerFactory: fakeProvider(sent, { reasoning: "思考", outputTokens: 512 }),
    });

    expect(sent[0]?.maxTokens).toBe(512);
    // 1,000 − 512 = 488. Two turns of 512 would have been 1,024.
    expect(sent[1]?.maxTokens).toBe(488);
    expect(sent[1]!.maxTokens).toBeLessThanOrEqual(488);
    expect(report.calls[1]?.maxOutputTokensRequested).toBe(488);
    expect(report.totals.outputTokens).toBeLessThanOrEqual(H0_LIMITS.cumulativeOutputTokens);
  });

  it("makes zero model calls when the model is not in the account list", async () => {
    const sent: StreamOptions[] = [];
    const report = await runH0Canary({
      apiKey: "sk-x",
      model: "deepseek-v4-pro",
      baseUrl: SCOPE.baseUrl,
      providerFactory: fakeProvider(sent, { reasoning: "思考" }),
      listModels: async () => ["deepseek-v4-flash", "deepseek-chat"],
    });

    expect(sent).toHaveLength(0);
    expect(report.requests.modelCalls).toBe(0);
    expect(report.preflight.modelsChecked).toBe(true);
    expect(report.preflight.modelPresent).toBe(false);
    expect(report.preflight.detail).toContain("不替换模型");
    expect(report.verdict).toBe("ABORTED");
  });

  it("requires an exact model match, not a prefix", async () => {
    const sent: StreamOptions[] = [];
    const report = await runH0Canary({
      apiKey: "sk-x",
      model: "deepseek-v4-pro",
      baseUrl: SCOPE.baseUrl,
      providerFactory: fakeProvider(sent, {}),
      listModels: async () => ["deepseek-v4-pro-preview"],
    });
    expect(report.preflight.modelPresent).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("parses every reported currency, not just the first entry", () => {
    const body = {
      balance_infos: [
        { currency: "CNY", total_balance: "12.5000" },
        { currency: "USD", total_balance: "1.7500" },
      ],
    };
    expect(parseBalances(body)).toEqual({ CNY: 12.5, USD: 1.75 });
    expect(parseBalances({ balance_infos: [] })).toBe("unknown");
    expect(parseBalances({})).toBe("unknown");

    const spend = diffBalances({ CNY: 12.5, USD: 1.75 }, { CNY: 12.4863, USD: 1.75 });
    expect(spend).toEqual({ CNY: 0.0137, USD: 0 });
    expect(diffBalances("unknown", { CNY: 1 })).toBe("unknown");
  });

  it("counts model, metadata and total HTTP requests separately", async () => {
    const sent: StreamOptions[] = [];
    const report = await runH0Canary({
      apiKey: "sk-x",
      model: "deepseek-v4-pro",
      baseUrl: SCOPE.baseUrl,
      providerFactory: fakeProvider(sent, { reasoning: "思考" }),
      listModels: async () => ["deepseek-v4-pro"],
      readBalance: async () => ({ CNY: 10 }),
    });

    expect(report.requests.modelCalls).toBe(2);
    expect(report.requests.metadataCalls).toBe(3); // models + balance ×2
    expect(report.requests.httpRequests).toBe(5);
    expect(report.requests.modelCalls).toBeLessThanOrEqual(H0_LIMITS.modelCalls);
    expect(report.requests.metadataCalls).toBeLessThanOrEqual(H0_LIMITS.metadataCalls);
    expect(report.requests.httpRequests).toBeLessThanOrEqual(H0_LIMITS.httpRequests);
  });

  it("states the published price and the administrative ceiling separately", async () => {
    const { report } = await run({ reasoning: "思考" });

    expect(report.cost.theoreticalWorstCaseCny).toBeNull();
    expect([0.66, 1.32]).toContain(report.cost.pricing?.inputCacheMissPerMillion);
    expect([1.98, 3.96]).toContain(report.cost.pricing?.outputPerMillion);
    expect(report.cost.pricing.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(report.cost.approvalCeilingCny).toBe(1);
    // The approval figure must not be dressed up as a code-enforced limit.
    expect(report.cost.note).toContain("行政审批额度");
    expect(report.cost.note).not.toContain("无已验证");
  });

  it("keeps the vault key out of the runner's arguments, logs and artifact", async () => {
    const source = await readFile(path.join("scripts", "h0-dpapi-runner.cjs"), "utf8");

    // The key must never travel as an argument or an environment variable.
    expect(source).not.toMatch(/process\.env\S*\s*=\s*[^=]/);
    expect(source).not.toMatch(/argv\.push|spawn|execFile|exec\(/);
    // It is decrypted locally and handed straight to the harness function.
    expect(source).toContain("decryptStringAsync");
    expect(source).toContain("runH0Canary");
    // Nothing prints the key itself — only its length.
    expect(source).not.toMatch(/out\(.*apiKey\s*\)|console\.log\(.*apiKey\s*\)/);
    expect(source).toContain("apiKey.length");
  });

  it("declares the limits it enforced in the artifact", async () => {
    const { report } = await run({ reasoning: "思考" });
    expect(report.limits).toEqual(H0_LIMITS);
    expect(report.notVerified.join(" ")).toContain("不代表模型质量");
  });
});
