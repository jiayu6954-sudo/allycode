import { describe, expect, it } from "vitest";
import { SettingsSchema } from "../../src/config/schema.js";
import { createProvider } from "../../src/providers/index.js";

describe("createProvider protocol routing", () => {
  it("routes Anthropic auto and explicit anthropic to its native adapter", () => {
    for (const providerProtocol of ["auto", "anthropic"] as const) {
      const provider = createProvider(SettingsSchema.parse({
        provider: "anthropic",
        apiKey: "test-key",
        providerProtocol,
      }));
      expect(provider.protocol).toBe("anthropic");
      expect(provider.protocol).toBe("anthropic");
    }
  });

  it("rejects non-Anthropic wire protocols for the Anthropic provider", () => {
    for (const providerProtocol of ["chat_completions", "responses"] as const) {
      expect(() => createProvider(SettingsSchema.parse({
        provider: "anthropic",
        apiKey: "test-key",
        providerProtocol,
      }))).toThrow(/only supports the Anthropic protocol/i);
    }
  });

  it("routes OpenAI auto to Responses while retaining an explicit Chat Completions escape hatch", () => {
    const automatic = createProvider(SettingsSchema.parse({
      provider: "openai",
      openaiApiKey: "test-key",
      providerProtocol: "auto",
    }));
    const responses = createProvider(SettingsSchema.parse({
      provider: "openai",
      openaiApiKey: "test-key",
      providerProtocol: "responses",
    }));
    const chat = createProvider(SettingsSchema.parse({
      provider: "openai",
      openaiApiKey: "test-key",
      providerProtocol: "chat_completions",
    }));

    expect(automatic.protocol).toBe("responses");
    expect(automatic.protocol).toBe("responses");
    expect(responses.protocol).toBe("responses");
    expect(chat.protocol).toBe("chat_completions");
    expect(chat.protocol).toBe("chat_completions");
  });

  it("keeps DeepSeek V4 on the verified Chat Completions adapter", () => {
    for (const providerProtocol of ["auto", "chat_completions"] as const) {
      const provider = createProvider(SettingsSchema.parse({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        deepseekApiKey: "test-key",
        providerProtocol,
      }));
      expect(provider.protocol).toBe("chat_completions");
      expect(provider.protocol).toBe("chat_completions");
    }
  });

  it("rejects the unimplemented DeepSeek Anthropic adapter", () => {
    for (const providerProtocol of ["anthropic"] as const) {
      expect(() => createProvider(SettingsSchema.parse({
        provider: "deepseek",
        deepseekApiKey: "test-key",
        providerProtocol,
      }))).toThrow(/no verified Responses|not configured with an Anthropic/i);
    }
  });

  it("routes custom auto/chat to Chat Completions and explicit responses to Responses", () => {
    for (const providerProtocol of ["auto", "chat_completions"] as const) {
      const provider = createProvider(SettingsSchema.parse({
        provider: "custom",
        customProviderUrl: "http://127.0.0.1:9000/v1",
        providerProtocol,
      }));
      expect(provider.protocol).toBe("chat_completions");
      expect(provider.protocol).toBe("chat_completions");
    }

    const responses = createProvider(SettingsSchema.parse({
      provider: "custom",
      customProviderUrl: "http://127.0.0.1:9000/v1",
      providerProtocol: "responses",
    }));
    expect(responses.protocol).toBe("responses");
    expect(responses.protocol).toBe("responses");
  });

  it("rejects unsupported protocols for custom, local, and other compatible providers", () => {
    expect(() => createProvider(SettingsSchema.parse({
      provider: "custom",
      customProviderUrl: "http://127.0.0.1:9000/v1",
      providerProtocol: "anthropic",
    }))).toThrow(/does not have an Anthropic-protocol adapter/i);

    expect(() => createProvider(SettingsSchema.parse({
      provider: "ollama",
      providerProtocol: "responses",
    }))).toThrow(/only supports Chat Completions/i);

    expect(() => createProvider(SettingsSchema.parse({
      provider: "qwen",
      qwenApiKey: "test-key",
      providerProtocol: "responses",
    }))).toThrow(/no verified Responses API adapter/i);
  });
});
