import { getAgentDatabase } from "../storage/agent-database.js";
import type {
  SessionSearchInput,
  ToolExecutionContext,
  ToolResult,
} from "../types/tools.js";

/** Search the durable event journal for prior work in the current project. */
export async function executeSessionSearch(
  input: SessionSearchInput,
  context: ToolExecutionContext,
): Promise<ToolResult> {
  const query = input.query.trim();
  if (!query) return { content: "搜索内容不能为空。", isError: true };

  const database = getAgentDatabase();
  const project = database.resolveProject(context.cwd);
  const events = database.searchEvents(query, input.limit ?? 12, project.id);
  if (events.length === 0) {
    return {
      content: `当前项目的历史任务中没有找到“${query}”。`,
      isError: false,
      metadata: { matchCount: 0 },
    };
  }

  const lines = [`项目历史搜索：“${query}”`, ""];
  for (const event of events) {
    const task = database.getTask(event.taskId);
    const payload = compactPayload(event.payload);
    lines.push(
      `- ${event.createdAt} · ${task?.title ?? "未命名任务"} · ${event.eventType}`,
      `  ${payload}`,
    );
  }
  lines.push("", "这些记录来自本地持久化事件日志；使用前请结合当前项目状态重新验证。 ");
  return {
    content: lines.join("\n"),
    isError: false,
    metadata: { matchCount: events.length },
  };
}

function compactPayload(payload: unknown): string {
  const text = typeof payload === "string"
    ? payload
    : JSON.stringify(payload) ?? String(payload ?? "");
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 600 ? `${normalized.slice(0, 597)}...` : normalized;
}
