import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  STRATEGIES,
  STRATEGY_VERSION,
  buildReport,
  replay,
} from "../../src/evals/replay-context-cost.js";
import type { ConversationMessage } from "../../src/types/agent.js";

/**
 * The three strategies must be genuinely different implementations, generated
 * by one script from one fixture. When `alpha8` and `candidate` were the same
 * config the comparison proved nothing — it reported a difference that came
 * from editing the script between runs, not from the strategies.
 */

const FIXTURE = path.join("test", "fixtures", "token-efficiency", "long-failed-delivery.json");
const FIXED = { systemTokens: 3_558, toolSchemaTokens: 4_196 };

function loadLongFixture(): { raw: string; messages: ConversationMessage[] } {
  const raw = fs.readFileSync(FIXTURE, "utf8");
  return { raw, messages: (JSON.parse(raw) as { messages: ConversationMessage[] }).messages };
}

const NO_FIXED = { systemTokens: 0, toolSchemaTokens: 0 };
const totalOf = (rows: Array<{ estimatedInputTokens: number }>): number =>
  rows.reduce((sum, row) => sum + row.estimatedInputTokens, 0);

/**
 * A request is sent BEFORE the assistant message it produces exists. Counting
 * that message in its own request billed a turn for text the model had not
 * written yet — a 35,000-character reply inflated its own first turn by ten
 * thousand tokens. These pin the ordering, not the resulting figures.
 */
describe("replay request ordering", () => {
  const hugeReply: ConversationMessage[] = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "X".repeat(35_000) },
  ];

  it("excludes the current assistant's text from its own request", () => {
    for (const name of ["legacy", "alpha8", "candidate"] as const) {
      const result = replay(hugeReply, STRATEGIES[name], NO_FIXED);
      expect(result.perTurn).toHaveLength(1);
      // Only the two-character user turn plus protocol overhead.
      expect(result.perTurn[0]!.estimatedInputTokens).toBeLessThan(50);
    }
  });

  it("excludes the current assistant's reasoning from its own request", () => {
    const thinking: ConversationMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "c1", name: "bash", input: {} }],
        providerState: { protocol: "deepseek-chat", reasoningContent: "R".repeat(20_000) },
      } as ConversationMessage,
    ];

    const result = replay(thinking, STRATEGIES.legacy, NO_FIXED);

    expect(result.perTurn[0]!.estimatedReasoningStateTokens).toBe(0);
    expect(result.perTurn[0]!.estimatedInputTokens).toBeLessThan(50);
  });

  it("includes the previous tool_use, its reasoning and the tool_result on the next request", () => {
    const exchange: ConversationMessage[] = [
      { role: "user", content: "读文件" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "c1", name: "file_read", input: { path: "a.ts" } }],
        providerState: { protocol: "deepseek-chat", reasoningContent: "R".repeat(700) },
      } as ConversationMessage,
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "T".repeat(1_400) }] } as ConversationMessage,
      { role: "assistant", content: [{ type: "text", text: "完成" }] } as ConversationMessage,
    ];

    const result = replay(exchange, STRATEGIES.legacy, NO_FIXED);

    expect(result.perTurn).toHaveLength(2);
    // Turn 1 carries only the opening user message.
    expect(result.perTurn[0]!.estimatedToolResultTokens).toBe(0);
    expect(result.perTurn[0]!.estimatedReasoningStateTokens).toBe(0);
    // Turn 2 is the continuation: it must carry all three.
    expect(result.perTurn[1]!.estimatedToolResultTokens).toBeGreaterThan(0);
    expect(result.perTurn[1]!.estimatedReasoningStateTokens).toBeGreaterThan(0);
    expect(result.perTurn[1]!.estimatedConversationTokens).toBeGreaterThan(
      result.perTurn[0]!.estimatedConversationTokens,
    );
  });

  it("ignores the size of a final assistant reply nothing follows", () => {
    const base: ConversationMessage[] = [
      { role: "user", content: "读文件" },
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "file_read", input: {} }] } as ConversationMessage,
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "ok" }] } as ConversationMessage,
    ];
    const shortTail = [...base, { role: "assistant" as const, content: [{ type: "text" as const, text: "完成" }] } as ConversationMessage];
    const longTail = [...base, { role: "assistant" as const, content: [{ type: "text" as const, text: "完成".repeat(5_000) }] } as ConversationMessage];

    expect(totalOf(replay(shortTail, STRATEGIES.legacy, NO_FIXED).perTurn))
      .toBe(totalOf(replay(longTail, STRATEGIES.legacy, NO_FIXED).perTurn));
  });

  it("charges a previous assistant reply only once a later request exists", () => {
    const settled: ConversationMessage[] = [
      { role: "user", content: "第一问" },
      { role: "assistant", content: "答".repeat(4_000) },
    ];
    const continued: ConversationMessage[] = [
      ...settled,
      { role: "user", content: "第二问" },
      { role: "assistant", content: "再答" },
    ];

    const before = totalOf(replay(settled, STRATEGIES.legacy, NO_FIXED).perTurn);
    const after = replay(continued, STRATEGIES.legacy, NO_FIXED);

    expect(after.perTurn).toHaveLength(2);
    // The bulky first reply is absent from turn 1 and present in turn 2.
    expect(after.perTurn[0]!.estimatedInputTokens).toBe(before);
    expect(after.perTurn[1]!.estimatedInputTokens).toBeGreaterThan(1_000);
  });

  it("trims before the request under in_place, not after", () => {
    // alpha.8 overwrote the transcript ahead of the call; the trimmed set must
    // therefore be what that same call was measured against.
    const { messages } = loadLongFixture();
    const inPlace = replay(messages, STRATEGIES.alpha8, NO_FIXED);
    const derived = replay(messages, STRATEGIES.candidate, NO_FIXED);

    expect(inPlace.sideEffects.contextTrims).toBeGreaterThan(0);
    expect(derived.sideEffects.contextTrims).toBeGreaterThan(inPlace.sideEffects.contextTrims);
  });

  it("does not mutate the canonical array under derived", () => {
    const { messages } = loadLongFixture();
    const snapshot = messages.length;
    replay(messages, STRATEGIES.candidate, NO_FIXED);
    expect(messages).toHaveLength(snapshot);
  });
});

describe("replay strategy semantics", () => {
  it("declares three distinct history modes", () => {
    expect(STRATEGIES.legacy.historyMode).toBe("none");
    expect(STRATEGIES.alpha8.historyMode).toBe("in_place");
    expect(STRATEGIES.candidate.historyMode).toBe("derived");
  });

  it("alpha8 and candidate behave differently on the long fixture", () => {
    const { messages } = loadLongFixture();
    const inPlace = replay(messages, STRATEGIES.alpha8, FIXED);
    const derived = replay(messages, STRATEGIES.candidate, FIXED);

    const total = (rows: typeof inPlace.perTurn) =>
      rows.reduce((sum, row) => sum + row.estimatedInputTokens, 0);

    // In-place overwriting oscillates: it trims, regrows, and trims again, so
    // it fires rarely and lets the working set climb between trims.
    expect(inPlace.sideEffects.contextTrims).toBeLessThan(derived.sideEffects.contextTrims);
    expect(total(derived.perTurn)).toBeLessThan(total(inPlace.perTurn));
    expect(total(inPlace.perTurn)).not.toBe(total(derived.perTurn));
  });

  it("keeps offline estimates reproducible and within the legacy baseline", () => {
    // These follow from the ordering rules above; they are a regression lock,
    // never a target. The earlier 51,625,059 / 8,849,133 / 3,883,329 were
    // measured with each assistant message counted inside its own request and
    // are superseded — the algorithm was not adjusted to preserve them.
    const { raw, messages } = loadLongFixture();
    const legacy = buildReport(FIXTURE, raw, messages, STRATEGIES.legacy, FIXED);
    const alpha8 = buildReport(FIXTURE, raw, messages, STRATEGIES.alpha8, FIXED);
    const candidate = buildReport(FIXTURE, raw, messages, STRATEGIES.candidate, FIXED);

    expect(legacy.estimated.resentInputTokens).toBe(51_386_224);
    expect(alpha8.estimated.resentInputTokens).toBeLessThan(legacy.estimated.resentInputTokens);
    expect(candidate.estimated.resentInputTokens).toBe(buildReport(FIXTURE, raw, messages, STRATEGIES.candidate, FIXED).estimated.resentInputTokens);
    expect(candidate.estimated.peakInputTokens).toBeLessThanOrEqual(60_000 + FIXED.systemTokens + FIXED.toolSchemaTokens);
  });

  it("stamps every artifact with the provenance needed to compare it later", () => {
    const { raw, messages } = loadLongFixture();
    const report = buildReport(FIXTURE, raw, messages.slice(0, 20), STRATEGIES.candidate, FIXED);

    expect(report.measurementKind).toBe("offline_estimate");
    expect(report.strategyVersion).toBe(STRATEGY_VERSION);
    expect(report.strategyConfig.historyMode).toBe("derived");
    expect(report.fixture.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.environment.replayScriptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.environment.gitCommit).not.toBe("");
    expect(typeof report.environment.gitDirty).toBe("boolean");
    // The disclaimer must travel with the numbers, not just the terminal output.
    expect(report.disclaimer).toContain("非 Provider 账单");
  });

  it("never lets legacy resend less than a budgeted strategy", () => {
    const { messages } = loadLongFixture();
    const rows = (["legacy", "alpha8", "candidate"] as const).map((name) =>
      replay(messages, STRATEGIES[name], FIXED).perTurn
        .reduce((sum, row) => sum + row.estimatedInputTokens, 0),
    );
    expect(rows[0]).toBeGreaterThan(rows[1]!);
    expect(rows[1]).toBeGreaterThan(rows[2]!);
  });
});
