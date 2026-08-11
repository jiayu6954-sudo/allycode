import type { Session } from "../src/memory/session.js";

export function safeExportFilename(value: string): string {
  const printable = Array.from(value)
    .filter((character) => character.charCodeAt(0) >= 32)
    .join("");
  const safe = printable
    .replace(/[<>:"/\\|?*]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 80);
  return safe || "AllyCode 会话";
}

export function renderSessionMarkdown(session: Session): string {
  const lines = [
    `# ${session.title ?? "AllyCode 会话"}`,
    "",
    `- 会话 ID：${session.id}`,
    `- 项目目录：${session.cwd}`,
    `- 模型：${session.model}`,
    `- 创建时间：${session.createdAt}`,
    `- 更新时间：${session.updatedAt}`,
    "",
    "---",
    "",
  ];

  for (const message of session.messages) {
    lines.push(message.role === "user" ? "## 用户" : "## AllyCode", "");
    if (typeof message.content === "string") {
      lines.push(message.content, "");
      continue;
    }
    for (const block of message.content) {
      if (block.type === "text") lines.push(block.text, "");
      else if (block.type === "tool_use") {
        lines.push(`### 工具调用：${block.name}`, "", "```json", JSON.stringify(block.input, null, 2), "```", "");
      } else if (block.type === "tool_result") {
        const content = typeof block.content === "string"
          ? block.content
          : (block.content ?? []).map((item) => item.type === "text" ? item.text : `[${item.type}]`).join("\n");
        lines.push(`### 工具结果${block.is_error ? "（失败）" : ""}`, "", "```text", content, "```", "");
      } else {
        lines.push(`[${block.type}]`, "");
      }
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
