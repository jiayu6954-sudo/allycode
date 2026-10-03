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
  if (!context.taskId) return {content:"当前入口没有绑定任务，历史检索不可用。",isError:true};
  if (database.getTask(context.taskId)?.projectId !== project.id) return {content:"任务与项目不匹配。",isError:true};
  const events = database.listMonitorEvents(context.taskId).filter(event => compactPayload(event.payload).toLowerCase().includes(query.toLowerCase())).slice(-(input.limit ?? 12));
  if (events.length === 0) {
    return {
      content: `当前任务中没有找到“${query}”。`,
      isError: false,
      metadata: { matchCount: 0 },
    };
  }

  const lines = [`当前任务历史搜索：“${query}”`, ""];
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
