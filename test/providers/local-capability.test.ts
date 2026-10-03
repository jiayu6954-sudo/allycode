import { afterEach, describe, expect, it, vi } from "vitest";
import {
  probeEndpoint,
  SmartLocalProvider,
  type LocalCapabilities,
  type LocalEndpoint,
} from "../../src/providers/local.js";

const ENDPOINT: LocalEndpoint = {
  name: "test-local",
  baseUrl: "http://127.0.0.1:11999/v1",
  modelsPath: "http://127.0.0.1:11999/v1/models",
  defaultModel: "qwen2.5-coder:32b",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function toolCallResponse(): Response {
  return jsonResponse({
    choices: [{
      message: {
        content: null,
        tool_calls: [{
          id: "call_local_probe",
          type: "function",
          function: {
            name: "allycode_capability_probe",
            arguments: JSON.stringify({ value: "ALPHA9" }),
          },
        }],
      },
    }],
  });
}

function finalResponse(text: string): Response {
  return jsonResponse({ choices: [{ message: { content: text } }] });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("local model capability certification", () => {
  it("does not certify a regex-matched model name without a real tool call", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: ENDPOINT.defaultModel }] }))
      .mockResolvedValueOnce(finalResponse("I can use tools."));
    vi.stubGlobal("fetch", fetchMock);

    const capabilities = await probeEndpoint(ENDPOINT);

    expect(capabilities).toMatchObject({
      supportsToolCalls: false,
      toolSupportHint: true,
      toolSupport: "prompt_fallback",
      agentTier: "L1_prompt_fallback",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("requires the post-tool acknowledgement before native_verified", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: ENDPOINT.defaultModel }] }))
      .mockResolvedValueOnce(toolCallResponse())
      .mockResolvedValueOnce(finalResponse("almost"));
    vi.stubGlobal("fetch", fetchMock);

    const capabilities = await probeEndpoint(ENDPOINT);

    expect(capabilities).toMatchObject({
      supportsToolCalls: false,
      toolSupport: "prompt_fallback",
      agentTier: "L1_prompt_fallback",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const secondProbeBody = JSON.parse(String(fetchMock.mock.calls[2]![1]?.body)) as {
      messages: Array<Record<string, unknown>>;
    };
    expect(secondProbeBody.messages).toContainEqual({
      role: "tool",
      tool_call_id: "call_local_probe",
      content: "ALLYCODE_TOOL_RESULT",
    });
  });

  it("does not certify a whitespace-padded post-tool acknowledgement", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: ENDPOINT.defaultModel }] }))
      .mockResolvedValueOnce(toolCallResponse())
      .mockResolvedValueOnce(finalResponse(" ALLYCODE_TOOL_OK\n"));
    vi.stubGlobal("fetch", fetchMock);

    const capabilities = await probeEndpoint(ENDPOINT);

    expect(capabilities).toMatchObject({
      supportsToolCalls: false,
      toolSupport: "prompt_fallback",
      agentTier: "L1_prompt_fallback",
    });
  });

  it("marks native_verified only after both non-streaming requests succeed", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: ENDPOINT.defaultModel }] }))
      .mockResolvedValueOnce(toolCallResponse())
      .mockResolvedValueOnce(finalResponse("ALLYCODE_TOOL_OK"));
    vi.stubGlobal("fetch", fetchMock);

    const capabilities = await probeEndpoint(ENDPOINT);

    expect(capabilities).toMatchObject({
      supportsToolCalls: true,
      toolSupportHint: true,
      toolSupport: "native_verified",
      agentTier: "L2_native_limited",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const call of fetchMock.mock.calls.slice(1)) {
      const body = JSON.parse(String(call[1]?.body)) as { stream?: boolean };
      expect(body.stream).toBe(false);
    }
  });

  it("keeps context length separate from the native provider output-token request", async () => {
    const capabilities: LocalCapabilities = {
      endpoint: ENDPOINT,
      availableModels: [ENDPOINT.defaultModel],
      supportsToolCalls: true,
      toolSupport: "native_verified",
      agentTier: "L3_agent_ready",
      toolSupportHint: true,
      contextLength: 65_536,
    };
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      const body = "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new SmartLocalProvider(capabilities, ENDPOINT.defaultModel);
    const handle = provider.stream({
      model: "ignored-by-smart-provider",
      maxTokens: 100_000,
      systemPrompt: "test",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    });
    for await (const _delta of handle.deltas()) { /* consume */ }
    await handle.finalMessage();

    const request = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as {
      max_tokens?: number;
    };
    expect(provider.contextLength).toBe(65_536);
    expect(request.max_tokens).toBe(100_000);
  });
});
