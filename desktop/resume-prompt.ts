import type { TaskRecord } from "../src/storage/agent-database.js";

export function buildResumePrompt(
  task: Pick<TaskRecord, "status" | "lastError" | "checkpoint">,
): string {
  const reason = task.lastError?.trim() || task.checkpoint?.note?.trim();
  return [
    "继续上次中断或验收未通过的任务。从已保存的检查点继续，不要重复已经完成的操作。",
    reason ? `上次停止原因：${reason}` : "",
    task.status === "failed" && reason
      ? "必须先解决上述未通过项并重新运行对应的真实验收；在证据通过前不要宣称任务完成。"
      : "",
  ].filter(Boolean).join("\n");
}
