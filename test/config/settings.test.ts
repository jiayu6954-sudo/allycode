import { beforeEach, describe, expect, it } from "vitest";
import { loadSettings, resetSettings, saveSettings } from "../../src/config/settings.js";
import type { AllyCodeSettings } from "../../src/config/schema.js";

const providers: AllyCodeSettings["provider"][] = [
  "anthropic",
  "openai",
  "deepseek",
  "qwen",
  "groq",
  "gemini",
  "ollama",
  "openrouter",
  "moonshot",
  "custom",
];

describe("provider settings persistence", () => {
  beforeEach(async () => resetSettings());

  it.each(providers)("writes and reloads free-form configuration for %s", async (provider) => {
    const model = `${provider}-future-model-2026`;
    const providerBaseUrls = provider === "custom"
      ? {}
      : { [provider]: `https://${provider}.gateway.example/v1` };
    await saveSettings({
      provider,
      model,
      providerBaseUrls,
      ...(provider === "custom"
        ? { customProviderUrl: "https://custom.gateway.example/v1" }
        : {}),
    });

    const reloaded = await loadSettings();
    expect(reloaded.provider).toBe(provider);
    expect(reloaded.model).toBe(model);
    if (provider === "custom") {
      expect(reloaded.customProviderUrl).toBe("https://custom.gateway.example/v1");
    } else {
      expect(reloaded.providerBaseUrls[provider]).toBe(`https://${provider}.gateway.example/v1`);
    }
  });

  it("persists the canonical lowercase DeepSeek V4 model id", async () => {
    await saveSettings({ provider: "deepseek", model: "DeepSeek-V4-Pro" });
    await expect(loadSettings()).resolves.toMatchObject({
      provider: "deepseek",
      model: "deepseek-v4-pro",
    });
  });
});
