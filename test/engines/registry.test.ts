import { describe, expect, it } from "vitest";
import { SettingsSchema } from "../../src/config/schema.js";
import { AGENT_ENGINE_DESCRIPTORS } from "../../src/engines/descriptors.js";
import { resolveAgentEngine } from "../../src/engines/registry.js";

describe("agent engine registry", () => {
  it("defaults auto mode to the native engine", () => {
    const settings = SettingsSchema.parse({});
    expect(settings.agentEngine.mode).toBe("auto");
    expect(resolveAgentEngine(settings)).toBe("native");
  });

  it("preserves an explicitly selected engine", () => {
    const settings = SettingsSchema.parse({ agentEngine: { mode: "codex" } });
    expect(resolveAgentEngine(settings)).toBe("codex");
  });

  it("publishes truthful maturity and external-runtime metadata", () => {
    expect(AGENT_ENGINE_DESCRIPTORS.native.maturity).toBe("stable");
    expect(AGENT_ENGINE_DESCRIPTORS.codex.capabilities.externalRuntime).toBe(true);
    expect(AGENT_ENGINE_DESCRIPTORS["deepseek-harness"].maturity).toBe("developer-preview");
  });
});
