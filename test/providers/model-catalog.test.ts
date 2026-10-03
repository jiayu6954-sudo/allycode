import { describe, expect, it, vi } from "vitest";
import {
  discoverModelCatalog,
  getRegisteredModelCapabilities,
  parseModelList,
} from "../../src/providers/model-catalog.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("parseModelList", () => {
  it("normalizes OpenAI and Anthropic data arrays", () => {
    expect(parseModelList({
      data: [
        { id: "model-10" },
        { id: "model-2" },
        { id: "model-2" },
        { id: "  model-1  " },
      ],
    })).toEqual(["model-1", "model-2", "model-10"]);
  });

  it("normalizes Ollama models arrays", () => {
    expect(parseModelList({
      models: [
        { name: "qwen3:14b" },
        { model: "qwen3:7b" },
        "qwen3:1.7b",
      ],
    })).toEqual(["qwen3:1.7b", "qwen3:7b", "qwen3:14b"]);
  });

  it("returns an empty list for malformed payloads", () => {
    expect(parseModelList(null)).toEqual([]);
    expect(parseModelList({ data: [{ nope: true }, null] })).toEqual([]);
  });
});

describe("DeepSeek V4 capability registry", () => {
  it.each(["deepseek-v4-pro", "deepseek-v4-flash"])(
    "registers official capabilities for %s with current supported adapter protocols",
    (model) => {
      const entry = getRegisteredModelCapabilities("deepseek", model);

      expect(entry).toMatchObject({
        id: model,
        verification: "official",
        protocols: ["chat_completions", "responses"],
        capabilities: {
          protocol: "chat_completions",
          contextWindow: 1_000_000,
          maxOutputTokens: 384_000,
          toolCalls: "native",
          reasoning: "supported",
          vision: model === "deepseek-v4-pro" ? "unsupported" : "supported",
          source: "official",
        },
      });
      expect(entry?.protocols).toContain("responses");
    },
  );

  it("does not guess capabilities for unknown model names", () => {
    expect(getRegisteredModelCapabilities("deepseek", "deepseek-v5-rumor")).toBeUndefined();
  });
});

describe("discoverModelCatalog", () => {
  it("marks provider-listed OpenAI-shape models live and keeps absent official fallbacks explicit", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      data: [
        { id: "deepseek-v4-pro" },
        { id: "account-special-model" },
        { id: "deepseek-v4-pro" },
      ],
    }));

    const result = await discoverModelCatalog({
      provider: "deepseek",
      apiKey: "ds-test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.retrieval).toBe("live");
    expect(result.models.map((model) => model.id)).toEqual([
      "account-special-model",
      "deepseek-flash",
      "deepseek-v4-flash",
      "deepseek-v4-pro",
    ]);
    expect(result.models.find((model) => model.id === "deepseek-v4-pro")).toMatchObject({
      source: "live",
      verification: "official",
    });
    expect(result.models.find((model) => model.id === "deepseek-v4-flash")).toMatchObject({
      source: "fallback",
      verification: "official",
    });
    expect(result.models.find((model) => model.id === "account-special-model")).toMatchObject({
      source: "live",
      verification: "provider-listed",
      capabilities: {
        toolCalls: "unverified",
        reasoning: "unverified",
      },
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.deepseek.com/v1/models",
      expect.objectContaining({
        headers: { Authorization: "Bearer ds-test-key" },
      }),
    );
  });

  it("uses Anthropic's models endpoint and authentication headers", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ id: "claude-test" }] }));

    const result = await discoverModelCatalog({
      provider: "anthropic",
      baseUrl: "https://gateway.example.test",
      apiKey: "anthropic-secret",
      selectedModel: "claude-selected",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "claude-test", source: "live" }),
      expect.objectContaining({ id: "claude-selected", source: "fallback" }),
    ]));
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://gateway.example.test/v1/models",
      expect.objectContaining({
        headers: {
          "x-api-key": "anthropic-secret",
          "anthropic-version": "2023-06-01",
        },
      }),
    );
  });

  it("uses Ollama tags and normalizes models[]", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      models: [{ name: "qwen3:8b" }, { name: "qwen3:4b" }],
    }));

    const result = await discoverModelCatalog({
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.models.map((model) => model.id)).toEqual(["qwen3:4b", "qwen3:8b"]);
    expect(result.models.every((model) => model.source === "live")).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/tags",
      expect.any(Object),
    );
  });

  it("falls back safely and redacts arbitrary configured credentials", async () => {
    const apiKey = "my completely custom secret";
    const fetchImpl = vi.fn(async () => {
      throw new Error(`request failed with credential ${apiKey}`);
    });

    const result = await discoverModelCatalog({
      provider: "deepseek",
      apiKey,
      selectedModel: "private-alias",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.retrieval).toBe("fallback");
    expect(result.warning).toContain("[已隐藏密钥]");
    expect(result.warning).not.toContain(apiKey);
    expect(result.models).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "private-alias",
        source: "fallback",
        verification: "unverified",
      }),
      expect.objectContaining({ id: "deepseek-v4-pro", verification: "official" }),
    ]));
  });

  it("does not expose HTTP response bodies in warnings", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(
      { error: "bad key sk-should-never-appear" },
      401,
    ));

    const result = await discoverModelCatalog({
      provider: "openai",
      selectedModel: "configured-model",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.warning).toBe("模型列表接口返回 HTTP 401，已使用本地候选列表。");
    expect(result.warning).not.toContain("sk-should-never-appear");
  });
});
