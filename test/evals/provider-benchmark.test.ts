import { describe, expect, it } from "vitest";
import { SettingsSchema } from "../../src/config/schema.js";
import {
  BenchmarkSuiteSchema,
  runProviderBenchmark,
} from "../../src/evals/provider-benchmark.js";
import type {
  AIProvider,
  NormalizedMessage,
  ProviderStreamHandle,
  StreamParams,
} from "../../src/providers/interface.js";

const suite = BenchmarkSuiteSchema.parse({
  schemaVersion: 1,
  id: "offline-test",
  title: "Offline benchmark harness test",
  description: "Tests scoring without a network call.",
  defaults: { timeoutMs: 5000, maxOutputTokens: 64 },
  cases: [
    {
      id: "chat",
      kind: "exact_text",
      description: "chat",
      system: "exact",
      prompt: "chat",
      expectedText: "ALLYCODE_CHAT_OK",
    },
    {
      id: "tool",
      kind: "tool_roundtrip",
      description: "tool",
      system: "tool",
      prompt: "tool",
      tool: {
        name: "grep",
        description: "grep",
        inputSchema: {
          type: "object",
          properties: { pattern: { type: "string" }, path: { type: "string" } },
          required: ["pattern", "path"],
        },
      },
      expectedInput: { pattern: "allycode_probe", path: "." },
      syntheticResult: "synthetic",
      expectedContinuationText: "ALLYCODE_TOOL_OK",
    },
    {
      id: "honesty",
      kind: "false_execution_sentinel",
      description: "honesty",
      system: "honesty",
      prompt: "honesty",
      expectedText: "ALLYCODE_NOT_EXECUTED",
      forbiddenPatterns: ["I executed"],
    },
    {
      id: "cache",
      kind: "cache_observation",
      description: "cache",
      required: false,
      system: "cache",
      prefixSeed: "fixed",
      repeatCount: 16,
      question: "cache",
      expectedText: "ALLYCODE_CACHE_OK",
    },
  ],
});

const settings = SettingsSchema.parse({
  provider: "deepseek",
  model: "deepseek-v4-pro",
  providerProtocol: "chat_completions",
});

describe("provider benchmark harness", () => {
  it("requires a real tool call and preserves provider state in the second round", async () => {
    const seen: StreamParams[] = [];
    const provider = scriptedProvider([
      textMessage("ALLYCODE_CHAT_OK"),
      {
        stop_reason: "tool_use",
        content: [{
          type: "tool_use",
          id: "call-1",
          name: "grep",
          input: { pattern: "allycode_probe", path: "." },
        }],
        usage: { input_tokens: 20, output_tokens: 5 },
        providerState: {
          protocol: "deepseek-chat",
          reasoningContent: "opaque reasoning state",
        },
      },
      textMessage("ALLYCODE_TOOL_OK"),
      textMessage("ALLYCODE_NOT_EXECUTED"),
      textMessage("ALLYCODE_CACHE_OK"),
      textMessage("ALLYCODE_CACHE_OK", 120),
    ], seen);

    const report = await runProviderBenchmark(settings, suite, undefined, provider);

    expect(report.summary.agentReadyForThisSuite).toBe(true);
    expect(report.summary.passedRequiredCases).toBe(3);
    expect(report.summary.usage.cacheReadTokens).toBe(120);
    expect(report.summary.usage.cacheObservation).toBe("observed");
    expect(seen).toHaveLength(6);

    const continuation = seen[2]!;
    expect(continuation.messages).toHaveLength(3);
    expect(continuation.messages[1]?.providerState).toEqual({
      protocol: "deepseek-chat",
      reasoningContent: "opaque reasoning state",
    });
    expect(continuation.messages[2]?.content).toEqual([{
      type: "tool_result",
      tool_use_id: "call-1",
      content: "synthetic",
      is_error: false,
    }]);
  });

  it("does not label a text-only model Agent-ready", async () => {
    const provider = scriptedProvider([
      textMessage("ALLYCODE_CHAT_OK"),
      textMessage("I cannot call tools"),
      textMessage("ALLYCODE_NOT_EXECUTED"),
      textMessage("ALLYCODE_CACHE_OK"),
      textMessage("ALLYCODE_CACHE_OK"),
    ]);

    const report = await runProviderBenchmark(settings, suite, undefined, provider);

    expect(report.summary.agentReadyForThisSuite).toBe(false);
    expect(report.summary.failedRequiredCases).toBe(1);
    expect(report.cases.find((result) => result.id === "tool")?.passed).toBe(false);
    expect(report.cases.find((result) => result.id === "tool")?.checks.tool_result_continuation?.detail)
      .toMatch(/无法合法执行第二轮续接/);
  });
});

function textMessage(text: string, cacheReadTokens?: number): NormalizedMessage {
  return {
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
    usage: {
      input_tokens: 10,
      output_tokens: 2,
      ...(cacheReadTokens === undefined ? {} : { cache_read_input_tokens: cacheReadTokens }),
    },
  };
}

function scriptedProvider(
  messages: NormalizedMessage[],
  seen: StreamParams[] = [],
): AIProvider {
  let index = 0;
  return {
    providerName: "deepseek",
    protocol: "chat_completions",
    stream(params): ProviderStreamHandle {
      seen.push(params);
      const message = messages[index++];
      if (!message) throw new Error(`Missing scripted response #${index}`);
      return {
        async *deltas() {
          for (const block of message.content) {
            if (block.type === "text") yield { type: "text" as const, text: block.text };
          }
        },
        async finalMessage() {
          return message;
        },
      };
    },
  };
}

