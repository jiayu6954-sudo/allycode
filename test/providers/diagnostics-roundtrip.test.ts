import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsSchema } from "../../src/config/schema.js";
import type {
  AIProvider,
  NormalizedMessage,
  ProviderStreamHandle,
  StreamParams,
} from "../../src/providers/interface.js";

const providerMocks = vi.hoisted(() => ({
  createProvider: vi.fn(),
}));

vi.mock("../../src/providers/index.js", () => ({
  createProvider: providerMocks.createProvider,
  PROVIDER_PRESETS: {},
}));

import { testProviderCompatibility } from "../../src/providers/diagnostics.js";

type RoundtripOutcome =
  | { kind: "message"; message: NormalizedMessage }
  | { kind: "error"; error: Error };

const PROVIDER_STATE = {
  protocol: "responses" as const,
  responseId: "resp_probe_1",
  outputItems: [{ type: "function_call", call_id: "probe_call_1" }],
};

function message(content: NormalizedMessage["content"], providerState?: NormalizedMessage["providerState"]): NormalizedMessage {
  return {
    stop_reason: content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn",
    content,
    usage: { input_tokens: 1, output_tokens: 1 },
    providerState,
  };
}

function handle(outcome: RoundtripOutcome): ProviderStreamHandle {
  return {
    async *deltas() { /* no streaming deltas are needed for this probe double */ },
    async finalMessage() {
      if (outcome.kind === "error") throw outcome.error;
      return outcome.message;
    },
  };
}

function installProvider(roundtrip: RoundtripOutcome): { provider: AIProvider; stream: ReturnType<typeof vi.fn> } {
  const queue: RoundtripOutcome[] = [
    { kind: "message", message: message([{ type: "text", text: "ALLYCODE_OK" }]) },
    {
      kind: "message",
      message: message([{
        type: "tool_use",
        id: "probe_call_1",
        name: "grep",
        input: { pattern: "allycode_probe", path: "." },
      }], PROVIDER_STATE),
    },
    roundtrip,
  ];
  const stream = vi.fn((_params: StreamParams) => {
    const next = queue.shift();
    if (!next) throw new Error("Unexpected provider call");
    return handle(next);
  });
  const provider: AIProvider = {
    providerName: "custom",
    protocol: "responses",
    stream,
  };
  providerMocks.createProvider.mockReturnValue(provider);
  return { provider, stream };
}

function settings() {
  return SettingsSchema.parse({
    provider: "custom",
    customProviderUrl: "http://127.0.0.1:9000/v1",
    model: "probe-model",
    providerProtocol: "responses",
  });
}

beforeEach(() => {
  providerMocks.createProvider.mockReset();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(
    JSON.stringify({ data: [{ id: "probe-model" }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  )));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("provider diagnostics tool-result round trip", () => {
  it("certifies agent_ready only after a second turn and preserves opaque providerState", async () => {
    const { stream } = installProvider({
      kind: "message",
      message: message([{ type: "text", text: "ALLYCODE_TOOL_OK" }]),
    });

    const result = await testProviderCompatibility(settings());

    expect(result.ok).toBe(true);
    expect(result.capability).toEqual({
      level: "agent_ready",
      protocol: "responses",
      nativeToolRoundtrip: true,
      source: "live_probe",
    });
    expect(result.stages.map((stage) => [stage.stage, stage.ok])).toEqual([
      ["configuration", true],
      ["model_discovery", true],
      ["chat", true],
      ["tool_call", true],
      ["tool_result_roundtrip", true],
    ]);
    expect(stream).toHaveBeenCalledTimes(3);

    const secondTurn = stream.mock.calls[2]![0] as StreamParams;
    expect(secondTurn.messages).toHaveLength(3);
    expect(secondTurn.messages[1]).toMatchObject({
      role: "assistant",
      providerState: PROVIDER_STATE,
      content: [{
        type: "tool_use",
        id: "probe_call_1",
        name: "grep",
      }],
    });
    expect(secondTurn.messages[2]).toEqual({
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "probe_call_1",
        content: "ALLYCODE_PROBE_RESULT",
      }],
    });
  });

  it("stops before chat when the selected model is absent from the account catalog", async () => {
    const { stream } = installProvider({
      kind: "message",
      message: message([{ type: "text", text: "unused" }]),
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ data: [{ id: "another-model" }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )));

    const result = await testProviderCompatibility(settings());

    expect(result.ok).toBe(false);
    expect(result.fieldErrors.model).toContain("当前账户不可见所选模型");
    expect(result.stages).toHaveLength(2);
    expect(result.stages[1]).toMatchObject({ stage: "model_discovery", ok: false });
    expect(stream).not.toHaveBeenCalled();
  });

  it.each([
    ["second-turn error", { kind: "error", error: new Error("roundtrip failed") } as RoundtripOutcome],
    ["repeated tool call", {
      kind: "message",
      message: message([{
        type: "tool_use",
        id: "probe_call_2",
        name: "grep",
        input: { pattern: "again", path: "." },
      }]),
    } as RoundtripOutcome],
    ["empty response", { kind: "message", message: message([]) } as RoundtripOutcome],
    ["non-exact acknowledgement", {
      kind: "message",
      message: message([{ type: "text", text: "ALLYCODE_TOOL_OK." }]),
    } as RoundtripOutcome],
    ["whitespace-padded acknowledgement", {
      kind: "message",
      message: message([{ type: "text", text: " ALLYCODE_TOOL_OK\n" }]),
    } as RoundtripOutcome],
  ])("rejects %s after the first tool call", async (_label, outcome) => {
    const { stream } = installProvider(outcome);

    const result = await testProviderCompatibility(settings());

    expect(stream).toHaveBeenCalledTimes(3);
    expect(result.ok).toBe(false);
    expect(result.capability.level).toBe("tool_call_only");
    expect(result.capability.nativeToolRoundtrip).toBe(false);
    expect(result.stages.at(-1)).toMatchObject({
      stage: "tool_result_roundtrip",
      ok: false,
    });
  });
});
