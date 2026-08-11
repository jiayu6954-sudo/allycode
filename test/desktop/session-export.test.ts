import { describe, expect, it } from "vitest";
import type { Session } from "../../src/memory/session.js";
import { renderSessionMarkdown, safeExportFilename } from "../../desktop/session-export.js";

function fixtureSession(): Session {
  return {
    id: "session-export",
    title: "修复 Windows: 导出/删除?",
    cwd: "D:\\Projects\\allycode",
    createdAt: "2026-08-08T08:00:00.000Z",
    updatedAt: "2026-08-08T08:05:00.000Z",
    model: "test-model",
    totalUsage: {
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostUsd: 0,
    },
    messages: [
      { role: "user", content: "请检查项目。" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "开始检查。" },
          { type: "tool_use", id: "tool-1", name: "read_file", input: { path: "README.md" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool-1", content: "# AllyCode" },
        ],
      },
    ],
  };
}

describe("session export", () => {
  it("creates a Windows-safe file name", () => {
    expect(safeExportFilename("修复 Windows: 导出/删除? ... "))
      .toBe("修复 Windows 导出 删除");
  });

  it("exports messages and tool activity as readable Markdown", () => {
    const markdown = renderSessionMarkdown(fixtureSession());
    expect(markdown).toContain("# 修复 Windows: 导出/删除?");
    expect(markdown).toContain("## 用户");
    expect(markdown).toContain("## AllyCode");
    expect(markdown).toContain("### 工具调用：read_file");
    expect(markdown).toContain('"path": "README.md"');
    expect(markdown).toContain("### 工具结果");
    expect(markdown).toContain("# AllyCode");
  });
});
