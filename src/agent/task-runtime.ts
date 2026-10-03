import { AgentDatabase } from "../storage/agent-database.js";
import { createSession, saveSession } from "../memory/session.js";
import { evaluateCompletionEvidence } from "../observability/completion-gate.js";
import { runAgentLoop } from "./loop.js";
import type { AIProvider } from "../providers/interface.js";
import type { AgentLoopOptions, AgentLoopResult } from "../types/agent.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { PermissionManager } from "../permissions/manager.js";
import { randomUUID } from "node:crypto";

/** Durable non-desktop entry point using the same journal/checkpoint/gate contract. */
export async function runDurableTask(cwd: string, provider: AIProvider, options: AgentLoopOptions, tools: ToolRegistry, permissions: PermissionManager): Promise<AgentLoopResult> {
  const database = new AgentDatabase();
  const project = database.resolveProject(cwd);
  const goal = options.conversationHistory.map((message) => typeof message.content === "string" ? message.content : message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n")).join("\n");
  const session = createSession(cwd, options.model);
  const task = database.createTask({ projectId: project.id, title: goal.slice(0, 80), goal });
  tools.setTaskScope(task.id);
  const runId = randomUUID();
  database.attachSession(task.id, session.id);
  database.updateTaskStatus(task.id, "running", { runId });
  try {
    const result = await runAgentLoop(provider, {
      ...options,
      onEvent: (event) => {
        if (!["text_delta", "thinking_delta", "tool_progress"].includes(event.type)) database.appendEvent(task.id, `agent_${event.type}`, event, runId);
        options.onEvent(event);
      },
      onCompactionChange: async (state) => { session.compactionState = state; await options.onCompactionChange?.(state); },
      onHistoryChange: async (history) => {
        session.messages = history;
        await saveSession(session);
        database.checkpointTask(task.id, { reason: "iteration", conversationHistory: history, compactionState: session.compactionState }, runId);
        await options.onHistoryChange?.(history);
      },
    }, tools, permissions);
    session.messages = result.updatedHistory;
    session.totalUsage = result.totalUsage;
    await saveSession(session);
    const interrupted = result.stopReason !== "end_turn";
    const gate = interrupted ? undefined : await evaluateCompletionEvidence(cwd, database.listMonitorEvents(task.id));
    if (gate) database.appendEvent(task.id, "completion_gate", gate, runId);
    if (gate?.status === "failed") result.stopReason = "verification_failed";
    database.checkpointTask(task.id, { reason: interrupted || gate?.status === "failed" ? "paused" : "completed", conversationHistory: result.updatedHistory, usage: result.totalUsage, compactionState: session.compactionState }, runId);
    database.updateTaskStatus(task.id, interrupted || gate?.status === "failed" ? "paused" : "completed", { runId });
    return result;
  } catch (error) {
    database.updateTaskStatus(task.id, options.signal?.aborted ? "paused" : "failed", { runId, note: String(error) });
    throw error;
  } finally { database.close(); }
}
