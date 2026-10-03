import type { ConversationMessage, UIContentBlock } from "../src/types/agent.js";
import type { DesktopContentBlock, DesktopMessage } from "./shared.js";
import type { PlanUpdateInput } from "../src/types/tools.js";

type ToolBlock = Extract<UIContentBlock, { type: "tool_use" }>;

/** One checklist per user turn, updated in its original place in the transcript. */
export function updateInlinePlan(content: DesktopContentBlock[], items: PlanUpdateInput["items"], beforeToolId?: string): DesktopContentBlock[] {
  const next = [...content];
  const existing = next.findIndex(block => block.type === "plan");
  const plan: DesktopContentBlock = { type: "plan", items };
  if (existing >= 0) next[existing] = plan;
  else {
    const anchor = next.findIndex(block => block.type === "tool_use" && block.toolId === beforeToolId);
    next.splice(anchor < 0 ? next.length : anchor, 0, plan);
  }
  return next;
}

function readPlan(input: unknown): PlanUpdateInput["items"] | undefined {
  if (!input || typeof input !== "object" || !("items" in input) || !Array.isArray(input.items)) return;
  if (!input.items.length || !input.items.every(item => item && typeof item.step === "string" && ["pending", "in_progress", "completed"].includes(item.status))) return;
  return input.items;
}

/** Reconstruct only this session's public transcript. Provider state is never accessed. */
export function toDesktopMessages(messages: ConversationMessage[]): DesktopMessage[] {
  const result: DesktopMessage[] = [];
  const pending = new Map<string, { block: ToolBlock; message: DesktopMessage }>();
  let assistant: DesktopMessage | undefined;
  const create = (role: DesktopMessage["role"]) => {
    const message: DesktopMessage = { id: `saved-${result.length}`, role, content: [], timestamp: "" };
    result.push(message);
    return message;
  };
  for (const message of messages) {
    const blocks = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
    let user: DesktopMessage | undefined;
    for (const block of blocks) {
      if (block.type === "tool_result") {
        const call = pending.get(block.tool_use_id);
        if (!call) continue;
        call.block.status = block.is_error ? "error" : "success";
        call.block.result = typeof block.content === "string" ? block.content : (block.content ?? []).map(item => item.type === "text" ? item.text : "[非文本结果]").join("\n");
        if (!block.is_error && call.block.toolName === "plan_update") {
          const items = readPlan(call.block.input);
          if (items) call.message.content = updateInlinePlan(call.message.content, items, call.block.toolId);
        }
        pending.delete(block.tool_use_id);
      } else if (block.type === "text" && message.role === "user") {
        user ??= create("user");
        user.content.push({ type: "text", text: block.text });
        assistant = undefined;
      } else if (message.role === "assistant" && (block.type === "text" || block.type === "tool_use")) {
        assistant ??= create("assistant");
        if (block.type === "text") assistant.content.push({ type: "text", text: block.text });
        else {
          const tool: ToolBlock = { type: "tool_use", toolName: block.name, toolId: block.id, input: block.input, status: "pending" };
          assistant.content.push(tool);
          pending.set(block.id, { block: tool, message: assistant });
        }
      }
    }
  }
  return result;
}

export function conversationTools(messages: DesktopMessage[]): ToolBlock[] {
  return messages.flatMap(message => message.content.filter((block): block is ToolBlock => block.type === "tool_use"));
}
