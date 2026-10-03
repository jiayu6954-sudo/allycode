import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AllyCodePluginManifestSchema,
  evaluatePluginTrust,
  resolvePluginEntrypoint,
} from "../../src/plugins/manifest.js";

describe("plugin manifest boundary", () => {
  const base = {
    schemaVersion: 1 as const,
    id: "example.safe-tool",
    name: "Safe tool",
    version: "1.0.0",
    description: "A test plugin",
    kind: "tool" as const,
    entrypoint: "dist/index.js",
    permissions: ["workspace:read" as const],
    engines: ["native" as const],
  };

  it("accepts a relative entrypoint and keeps it inside the plugin root", () => {
    const manifest = AllyCodePluginManifestSchema.parse(base);
    expect(resolvePluginEntrypoint("C:\\plugins\\safe", manifest)).toBe(
      path.resolve("C:\\plugins\\safe", "dist/index.js"),
    );
  });

  it("rejects traversal and absolute entrypoints", () => {
    expect(() => AllyCodePluginManifestSchema.parse({ ...base, entrypoint: "../escape.js" })).toThrow();
    expect(() => AllyCodePluginManifestSchema.parse({ ...base, entrypoint: "C:\\escape.js" })).toThrow();
  });

  it("does not silently trust powerful unsigned plugins", () => {
    const manifest = AllyCodePluginManifestSchema.parse({
      ...base,
      permissions: ["workspace:write", "process:execute"],
    });
    const decision = evaluatePluginTrust(manifest);
    expect(decision.requiresUserApproval).toBe(true);
    expect(decision.reasons.join(" ")).toContain("高风险权限");
  });

  it("blocks secrets access without publisher and integrity evidence", () => {
    const manifest = AllyCodePluginManifestSchema.parse({
      ...base,
      permissions: ["secrets:read"],
    });
    expect(evaluatePluginTrust(manifest).allowed).toBe(false);
  });
});
