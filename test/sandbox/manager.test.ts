import { describe, expect, it } from "vitest";
import { SandboxManager, type SandboxConfig } from "../../src/sandbox/manager.js";

function config(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
  return {
    enabled: true,
    level: "standard",
    image: "node:20-slim",
    timeoutMs: 30_000,
    maxMemoryMb: 512,
    allowNetwork: true,
    persistent: false,
    pidsLimit: 256,
    fallbackToHost: false,
    ...overrides,
  };
}

describe("SandboxManager", () => {
  it("builds a hardened non-root Docker command", () => {
    const manager = new SandboxManager(config());
    const args = manager.buildArgs("npm test", "/d/projects/demo");

    expect(args).toContain("--cap-drop");
    expect(args).toContain("ALL");
    expect(args).toContain("no-new-privileges");
    expect(args).toContain("--pids-limit");
    expect(args).toContain("256");
    expect(args).toContain("--read-only");
    expect(args).toContain("1000:1000");
    expect(args).toContain("bridge");
    expect(args).toContain("/d/projects/demo:/workspace");
  });

  it("forces strict workspaces to read-only with no network", () => {
    const manager = new SandboxManager(config({ level: "strict", allowNetwork: true }));
    const args = manager.buildArgs("rg TODO", "/workspace/project");

    expect(args).toContain("/workspace/project:/workspace:ro");
    const networkIndex = args.indexOf("--network");
    expect(args[networkIndex + 1]).toBe("none");
  });

  it("normalizes Windows workspace paths for Docker Desktop", () => {
    const manager = new SandboxManager(config());
    expect(manager.toDockerPath("E:\\Workspaces\\inventory-agent"))
      .toBe("/e/Workspaces/inventory-agent");
  });

  it("does not permit silent host fallback by default", () => {
    const manager = new SandboxManager(config());
    expect(manager.fallbackToHost).toBe(false);
  });
});
