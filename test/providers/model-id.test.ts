import { describe, expect, it } from "vitest";
import { normalizeProviderModelId } from "../../src/providers/model-id.js";

describe("provider model id normalization", () => {
  it("canonicalizes known DeepSeek identifiers without rewriting unknown future ids", () => {
    expect(normalizeProviderModelId("deepseek", " DeepSeek-V4-Pro ")).toBe("deepseek-v4-pro");
    expect(normalizeProviderModelId("deepseek", "DEEPSEEK-V4-FLASH")).toBe("deepseek-v4-flash");
    expect(normalizeProviderModelId("deepseek", "DeepSeek-Future-X")).toBe("DeepSeek-Future-X");
  });

  it("does not lowercase case-sensitive custom model ids", () => {
    expect(normalizeProviderModelId("custom", "Vendor/Model-X")).toBe("Vendor/Model-X");
  });
});

