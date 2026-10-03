import { describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { runAgentLoop, enforceReasoningRetention } from "../../src/agent/loop.js";
import { applyHistoryBudget, estimateHistoryTokens } from "../../src/agent/history-budget.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PermissionManager } from "../../src/permissions/manager.js";
import { loadSettings } from "../../src/config/settings.js";
import type { AIProvider, NormalizedMessage, ProviderStreamHandle, StreamOptions } from "../../src/providers/interface.js";
import type { ConversationMessage, AgentEvent } from "../../src/types/agent.js";

/**
 * The canonical transcript is the user's durable record: session export,
 * resume, and memory extraction all read it. The context budget exists to
 * shrink what the MODEL receives, and must never shorten that record — a
 * token saving paid for with the user's history is not a saving.
 */

function fingerprint(messages: ConversationMessage[]): string {
  return crypto.createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}

/**
 * Hash of the conversation itself — role and content — excluding provider
 * continuation state. That state is protocol plumbing the durable record must
 * NOT keep (see the reasoning-retirement requirement), so including it here
 * would make two correct requirements contradict each other.
 */
function contentFingerprint(messages: ConversationMessage[]): string {
  const stripped = messages.map(({ role, content }) => ({ role, content }));
  return crypto.createHash("sha256").update(JSON.stringify(stripped)).digest("hex");
}

/**
 * Records what was sent. Compaction issues its own summarisation calls through
 * the same provider, so those are captured separately — counting them as main
 * turns would make every assertion about "the request" ambiguous.
 */
function recordingProvider(
  sent: ConversationMessage[][],
  summaryCalls: ConversationMessage[][] = [],
): AIProvider {
  return {
    stream(options: StreamOptions): ProviderStreamHandle {
      const isSummary = options.tools.length === 0;
      const bucket = isSummary ? summaryCalls : sent;
      bucket.push(options.messages.map((message) => ({ ...message })));
      const final: NormalizedMessage = {
        stop_reason: "end_turn",
        content: [{ type: "text", text: "完成" }],
        usage: { input_tokens: 10, output_tokens: 2 },
      };
      return {
        async *deltas() { yield { type: "text" as const, text: "完成" }; },
        finalMessage: async () => final,
      } as unknown as ProviderStreamHandle;
    },
  } as unknown as AIProvider;
}

/** A long transcript with big tool results, guaranteed to exceed any budget. */
function longHistory(turns: number): ConversationMessage[] {
  const messages: ConversationMessage[] = [{ role: "user", content: "从零交付这个项目" }];
  for (let index = 0; index < turns; index++) {
    messages.push({
      role: "assistant",
      content: [{ type: "tool_use", id: `t${index}`, name: "bash", input: { command: `step ${index}` } }],
      providerState: {
        protocol: "deepseek-chat",
        scope: { provider: "deepseek", protocol: "chat_completions", model: "deepseek-v4-pro", baseUrl: "https://api.deepseek.com/v1" },
        reasoningContent: `第 ${index} 轮的思考`.repeat(40),
      },
    } as ConversationMessage);
    messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `t${index}`, content: "R".repeat(3_000), is_error: false }],
    } as ConversationMessage);
  }
  return messages;
}

async function runOnce(history: ConversationMessage[], compact = true): Promise<{
  sent: ConversationMessage[][];
  summaryCalls: ConversationMessage[][];
  result: Awaited<ReturnType<typeof runAgentLoop>>;
  events: AgentEvent[];
  persisted: ConversationMessage[][];
}> {
  const sent: ConversationMessage[][] = [];
  const summaryCalls: ConversationMessage[][] = [];
  const events: AgentEvent[] = [];
  const persisted: ConversationMessage[][] = [];
  const settings = await loadSettings();
  const result = await runAgentLoop(
    recordingProvider(sent, summaryCalls),
    {
      model: "deepseek-v4-pro",
      maxTokens: 4_096,
      systemPrompt: "You are AllyCode.",
      conversationHistory: history,
      onEvent: (event) => events.push(event),
      onHistoryChange: (updated) => { persisted.push(updated); },
      historyBudget: { maxContextTokens: 6_000, keepRecentMessages: 10 },
      compactContext: compact,
    },
    new ToolRegistry(process.cwd()),
    PermissionManager.createPermissive(settings),
  );
  return { sent, summaryCalls, result, events, persisted };
}

describe("canonical transcript vs model working context", () => {
  it("does not shorten the canonical transcript when the budget trims", async () => {
    const history = longHistory(60);
    const before = { count: history.length, hash: contentFingerprint(history) };

    const { result, events } = await runOnce(history);

    const trim = events.find((event) => event.type === "context_budget");
    expect(trim, "the budget must actually have fired for this to prove anything").toBeDefined();
    if (trim?.type === "context_budget") {
      // The event itself must show the two views diverging, not converging.
      expect(trim.workingMessages).toBeLessThan(trim.canonicalMessages);
      expect(trim.canonicalMessages).toBeGreaterThanOrEqual(before.count);
    }

    // Requirement 1: canonical count and conversation content are untouched.
    expect(result.updatedHistory.length).toBeGreaterThanOrEqual(before.count);
    const canonicalPrefix = result.updatedHistory.slice(0, before.count);
    expect(canonicalPrefix).toHaveLength(before.count);
    expect(contentFingerprint(canonicalPrefix)).toBe(before.hash);
  });

  it("sends the provider a working context inside the budget", async () => {
    const history = longHistory(60);
    const { sent } = await runOnce(history);

    expect(sent).toHaveLength(1);
    const working = sent[0]!;
    // Requirement 2: what went on the wire is far smaller than the record.
    expect(working.length).toBeLessThan(history.length);
    expect(estimateHistoryTokens(working)).toBeLessThanOrEqual(6_000 * 1.1);
  });

  it("keeps early, middle and recent messages in the exported record", async () => {
    const history = longHistory(60);
    history[0] = { role: "user", content: "EARLIEST-MARKER 从零交付这个项目" };
    const middle = Math.floor(history.length / 2);
    history[middle] = { role: "user", content: "MIDDLE-MARKER 中途的补充说明" };

    const { result } = await runOnce(history);
    const exported = JSON.stringify(result.updatedHistory);

    // Requirement 3: an export must still contain all three eras.
    expect(exported).toContain("EARLIEST-MARKER");
    expect(exported).toContain("MIDDLE-MARKER");
    expect(exported).toContain("完成");
  });

  it("hands the same complete record to every history-change listener", async () => {
    const history = longHistory(40);
    const { persisted, result } = await runOnce(history);

    // Requirement 4: what a desktop restart reloads is the full record.
    expect(persisted.length).toBeGreaterThan(0);
    for (const snapshot of persisted) {
      expect(snapshot.length).toBeGreaterThanOrEqual(history.length);
    }
    expect(persisted.at(-1)).toHaveLength(result.updatedHistory.length);
  });

  it("preserves the user's original goal even under the tightest budget", async () => {
    const history = longHistory(80);
    history[0] = { role: "user", content: "ORIGINAL-GOAL 必须保留的硬约束" };

    const { result, sent } = await runOnce(history);

    // Requirement 5: the goal survives in the record and in what the model sees.
    expect(JSON.stringify(result.updatedHistory)).toContain("ORIGINAL-GOAL");
    expect(JSON.stringify(sent[0])).toContain("ORIGINAL-GOAL");
  });

  it("leaves memory extraction a complete transcript to work from", async () => {
    const history = longHistory(50);
    const { result } = await runOnce(history);

    // Requirement 6: extraction reads updatedHistory; it must not be the
    // trimmed view, or long-term memory learns from a mutilated conversation.
    const toolResults = result.updatedHistory.filter(
      (message) => Array.isArray(message.content) &&
        message.content.some((block) => block.type === "tool_result"),
    );
    expect(toolResults).toHaveLength(50);
  });

  it("keeps required continuation state across completed turns", async () => {
    const history = longHistory(30);
    const stillCarrying = (messages: ConversationMessage[]): number =>
      messages.filter((message) => {
        const state = message.providerState;
        return state?.protocol === "deepseek-chat" && Boolean(state.reasoningContent);
      }).length;

    expect(stillCarrying(history)).toBe(30);
    const { result } = await runOnce(history);

    // Runtime continuation stays intact; durable serialization externalizes it.
    expect(stillCarrying(result.updatedHistory)).toBe(30);
  });

  it("leaves other protocols' continuation state alone", () => {
    // Responses opaque items are what ITS continuation replays; deleting them
    // would break that transport rather than save anything.
    const messages: ConversationMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "a", name: "bash", input: {} }],
        providerState: { protocol: "responses", responseId: "resp_1", outputItems: [{ keep: true }] },
      } as ConversationMessage,
    ];

    expect(enforceReasoningRetention(messages)).toBe(0);
    expect(messages[0]?.providerState).toMatchObject({
      protocol: "responses",
      responseId: "resp_1",
      outputItems: [{ keep: true }],
    });
  });

  it("keeps continuation state after tool results arrive", () => {
    const withReasoning = (id: string) => ({
      role: "assistant" as const,
      content: [{ type: "tool_use" as const, id, name: "bash", input: {} }],
      providerState: {
        protocol: "deepseek-chat" as const,
        reasoningContent: `思考 ${id}`,
      },
    }) as ConversationMessage;
    const answer = (id: string) => ({
      role: "user" as const,
      content: [{ type: "tool_result" as const, tool_use_id: id, content: "ok" }],
    }) as ConversationMessage;

    // Pending tool round: the turn being continued keeps its thinking.
    const pending: ConversationMessage[] = [withReasoning("c1")];
    expect(enforceReasoningRetention(pending)).toBe(0);
    expect(reasoningOf(pending[0])).toBe("思考 c1");

    // Every retained assistant turn keeps its own protocol state.
    const mixed: ConversationMessage[] = [
      withReasoning("c1"), answer("c1"), withReasoning("c2"),
    ];
    expect(enforceReasoningRetention(mixed)).toBe(0);
    expect(reasoningOf(mixed[0])).toBe("思考 c1");
    expect(reasoningOf(mixed[2])).toBe("思考 c2");

    // Answered turns must also be usable in the next user exchange.
    const settled: ConversationMessage[] = [
      withReasoning("c1"), answer("c1"), withReasoning("c2"), answer("c2"),
    ];
    enforceReasoningRetention(settled);
    expect(reasoningOf(settled[0])).toBe("思考 c1");
    expect(reasoningOf(settled[2])).toBe("思考 c2");
  });

  it("derives the working context without mutating its input", () => {
    const history = longHistory(40);
    const hash = fingerprint(history);

    const first = applyHistoryBudget(history, { maxContextTokens: 5_000, keepRecentMessages: 10 });
    const second = applyHistoryBudget(history, { maxContextTokens: 5_000, keepRecentMessages: 10 });

    expect(fingerprint(history)).toBe(hash);
    // Deriving twice from the same record must give the same working context.
    expect(fingerprint(first.messages)).toBe(fingerprint(second.messages));
  });
});

function reasoningOf(message: ConversationMessage | undefined): string | undefined {
  const state = message?.providerState;
  return state?.protocol === "deepseek-chat" ? state.reasoningContent : undefined;
}

describe("reasoning state across a real two-round tool exchange", () => {
  /** Emits a tool call carrying thinking text, then a plain end_turn reply. */
  function twoRoundProvider(sent: ConversationMessage[][]): AIProvider {
    let round = 0;
    return {
      stream(options: StreamOptions): ProviderStreamHandle {
        sent.push(options.messages.map((message) => ({ ...message })));
        round++;
        const final: NormalizedMessage = round === 1
          ? {
              stop_reason: "tool_use",
              content: [{ type: "tool_use", id: "call_1", name: "file_read", input: { path: "a.ts" } }],
              usage: { input_tokens: 10, output_tokens: 5 },
              providerState: {
                protocol: "deepseek-chat",
                scope: { provider: "deepseek", protocol: "chat_completions", model: "deepseek-v4-pro", baseUrl: "https://api.deepseek.com/v1" },
                reasoningContent: "第一轮的思考内容",
              },
            }
          : {
              stop_reason: "end_turn",
              content: [{ type: "text", text: "读完了" }],
              usage: { input_tokens: 12, output_tokens: 4 },
              providerState: {
                protocol: "deepseek-chat",
                scope: { provider: "deepseek", protocol: "chat_completions", model: "deepseek-v4-pro", baseUrl: "https://api.deepseek.com/v1" },
                reasoningContent: "最终回复的思考内容",
              },
            };
        return {
          async *deltas() { yield { type: "text" as const, text: "" }; },
          finalMessage: async () => final,
        } as unknown as ProviderStreamHandle;
      },
    } as unknown as AIProvider;
  }

  it("retains tool and final-response state for the next user turn", async () => {
    const sent: ConversationMessage[][] = [];
    const settings = await loadSettings();
    const result = await runAgentLoop(
      twoRoundProvider(sent),
      {
        model: "deepseek-v4-pro",
        maxTokens: 4_096,
        systemPrompt: "You are AllyCode.",
        conversationHistory: [{ role: "user", content: "读一下 a.ts" }],
        onEvent: () => {},
      },
      new ToolRegistry(process.cwd()),
      PermissionManager.createPermissive(settings),
    );

    // Round two replays the pending tool turn — its thinking must be there and
    // must survive serialisation, which is how the provider sends it.
    expect(sent).toHaveLength(2);
    const replayed = sent[1]!.find((message) => reasoningOf(message) !== undefined);
    expect(reasoningOf(replayed)).toBe("第一轮的思考内容");
    expect(JSON.parse(JSON.stringify(sent[1]))).toEqual(sent[1]);

    // Both states must be available for a later request carrying tools.
    const carrying = result.updatedHistory.filter((message) => reasoningOf(message) !== undefined);
    expect(carrying).toHaveLength(2);
    expect(JSON.stringify(result.updatedHistory)).toContain("第一轮的思考内容");
    expect(JSON.stringify(result.updatedHistory)).toContain("最终回复的思考内容");
  });
});

describe("working-context derivation cost", () => {
  it("stays linear as the canonical transcript grows", () => {
    // Recomputing from canonical every turn would be O(n²) without memoised
    // per-message estimates. Guard the property rather than the wall clock.
    const history = longHistory(200).map(({ providerState: _private, ...message }) => message);
    const spy = vi.spyOn(JSON, "stringify");
    applyHistoryBudget(history, { maxContextTokens: 6_000, keepRecentMessages: 10 });
    const firstPass = spy.mock.calls.length;
    spy.mockClear();
    applyHistoryBudget(history, { maxContextTokens: 6_000, keepRecentMessages: 10 });
    const secondPass = spy.mock.calls.length;
    spy.mockRestore();

    expect(secondPass).toBeLessThan(firstPass);
  });
});

describe("context compaction replaces the dropped span", () => {
  it("writes a summary instead of leaving only a removal marker", async () => {
    const history = longHistory(60);
    const { sent, summaryCalls } = await runOnce(history, true);

    // The summariser ran, and it was fed the span about to disappear.
    expect(summaryCalls.length).toBeGreaterThan(0);
    const bridge = JSON.stringify(sent[0]);
    expect(bridge).toContain("工具执行记录");
    expect(bridge).toContain("叙事回忆");
    expect(bridge).not.toContain("且未生成摘要");
  });

  it("labels the narrative as recollection, never as evidence", async () => {
    const { sent } = await runOnce(longHistory(60), true);
    const bridge = JSON.stringify(sent[0]);

    // The whole point: a later turn must not read the summary as proof.
    expect(bridge).toContain("不是证据");
    expect(bridge).toContain("必须重新验证后才能采信");
  });

  it("carries deterministic facts that the model cannot invent", async () => {
    const { sent } = await runOnce(longHistory(60), true);
    const bridge = JSON.stringify(sent[0]);

    // Commands come straight off the dropped tool calls.
    expect(bridge).toContain("工具调用");
    expect(bridge).toMatch(/step \d+/);
  });

  it("falls back to the bare marker when summarisation is disabled", async () => {
    const { sent, summaryCalls } = await runOnce(longHistory(60), false);

    expect(summaryCalls).toHaveLength(0);
    expect(JSON.stringify(sent[0])).toContain("且未生成摘要");
  });

  it("still keeps the original goal alongside the summary", async () => {
    const history = longHistory(80);
    history[0] = { role: "user", content: "ORIGINAL-GOAL 必须保留的硬约束" };
    const { sent } = await runOnce(history, true);

    expect(JSON.stringify(sent[0])).toContain("ORIGINAL-GOAL");
  });

  it("reports summarisation as a cost, not as free", async () => {
    const { events } = await runOnce(longHistory(60), true);
    const budget = events.find((event) => event.type === "context_budget");

    expect(budget?.type).toBe("context_budget");
    if (budget?.type === "context_budget") {
      expect(budget.summarised).toBe(true);
      expect(budget.summaryModelCalls).toBeGreaterThan(0);
    }
  });
});
