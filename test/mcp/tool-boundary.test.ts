import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { MCPRegistry } from "../../src/mcp/registry.js";

describe("MCP tool execution boundary", () => {
  it("caps untrusted MCP output like native tool output", async () => {
    const fakeMcp = {
      getToolDefinitions: () => [],
      hasTool: (name: string) => name === "fixture__huge",
      execute: async () => ({ content: "x".repeat(60_000) }),
    } as unknown as MCPRegistry;
    const registry = new ToolRegistry(process.cwd(), fakeMcp);

    const result = await registry.execute("fixture__huge", {});

    expect(result.content.length).toBeLessThan(51_000);
    expect(result.content).toContain("Result truncated");
    expect(result.metadata?.truncated).toBe(true);
  });
});
