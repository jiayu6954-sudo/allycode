import { describe, expect, it } from "vitest";
import { analyzeAgentTask, createDiagnosticExport } from "../../src/observability/agent-monitor.js";
import type { TaskEventRecord, TaskRecord } from "../../src/storage/agent-database.js";

const task: TaskRecord = {
  id: "task-1",
  projectId: "project-1",
  title: "修复价格模块",
  goal: "修复价格模块并运行测试",
  status: "completed",
  createdAt: "2026-08-13T00:00:00.000Z",
  updatedAt: "2026-08-13T00:01:00.000Z",
  startedAt: "2026-08-13T00:00:01.000Z",
  completedAt: "2026-08-13T00:01:00.000Z",
  revision: 1,
};

function event(id: number, eventType: string, payload: unknown, seconds = id): TaskEventRecord {
  return {
    id,
    taskId: task.id,
    runId: "run-1",
    eventType,
    payload,
    createdAt: new Date(Date.parse(task.createdAt) + seconds * 1_000).toISOString(),
  };
}

describe("agent monitor", () => {
  it("surfaces auxiliary failures even with reported usage, and deduplicates call updates",()=>{
    const call={id:"summary",purpose:"compaction",status:"reported",failureKind:"finalization_error",diagnostic:{code:"reasoning_only_limit"}};
    const report=analyzeAgentTask(task,[event(1,"agent_model_call",{record:{...call,status:"reserved",failureKind:undefined}}),event(2,"agent_model_call",{record:call}),event(3,"agent_model_call",{record:call})]);
    const alert=report.alerts.find(item=>item.code==="AUXILIARY_MODEL_FAILURE");
    expect(alert?.detail).toContain("1 次辅助调用失败");expect(alert?.evidenceEventIds).toEqual([3]);
  });
  it("scores a verified plan/tool/test closed loop from evidence", () => {
    const report = analyzeAgentTask(task, [
      event(1, "agent_run_context", { provider: "deepseek", model: "deepseek-v4-pro", protocol: "auto" }),
      event(2, "agent_status", { phase: "waiting_model" }),
      event(3, "agent_stream_signal", { signal: "tool" }),
      event(4, "agent_plan_update", { items: [{ step: "修复并验证", status: "completed" }] }),
      event(5, "agent_tool_start", { toolId: "write", toolName: "file_edit", input: { path: "src/a.ts" } }),
      event(6, "agent_tool_result", { toolId: "write", toolName: "file_edit", content: "ok", isError: false }),
      event(7, "agent_tool_start", { toolId: "test", toolName: "bash", input: { command: "npm test" } }),
      event(8, "agent_tool_result", { toolId: "test", toolName: "bash", content: "passed\n[Exit code: 0]", isError: false }),
      event(9, "agent_usage", { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 500, cacheWriteTokens: 0 }),
      event(10, "checkpoint_saved", { reason: "completed" }),
      event(11, "task_completed", {}),
    ]);

    expect(report.task.model).toBe("deepseek-v4-pro");
    expect(report.metrics.firstSignalMs).toBe(1_000);
    expect(report.metrics.toolSuccesses).toBe(2);
    expect(report.metrics.cacheReadRate).toBeCloseTo(1 / 3);
    expect(report.scores.find((score) => score.dimension === "evidence")?.score).toBe(100);
    expect(report.alerts).toEqual([]);
  });

  it("detects repeated tools, error loops, missing plans, and unverified completion", () => {
    const events: TaskEventRecord[] = [];
    let id = 1;
    events.push(event(id++, "agent_tool_start", { toolId: "write", toolName: "file_write", input: { path: "src/a.ts", content: "secret source" } }));
    events.push(event(id++, "agent_tool_result", { toolId: "write", toolName: "file_write", content: "ok", isError: false }));
    for (let index = 0; index < 4; index++) {
      events.push(event(id++, "agent_tool_start", { toolId: `grep-${index}`, toolName: "grep", input: { pattern: "TODO" } }));
      events.push(event(id++, "agent_tool_result", { toolId: `grep-${index}`, toolName: "grep", content: "failed", isError: true }));
    }
    events.push(event(id, "task_completed", {}));

    const report = analyzeAgentTask(task, events);
    const codes = report.alerts.map((alert) => alert.code);
    expect(codes).toContain("repeated_tool");
    expect(codes).toContain("tool_error_loop");
    expect(codes).toContain("missing_plan");
    expect(codes).toContain("unverified_change");
  });

  it("redacts credentials and bounds exported diagnostic text", () => {
    const report = analyzeAgentTask({ ...task, title: "key sk-title-secret-123456", goal: "use sk-super-secret-1234567890" }, [
      event(1, "agent_plan_update", { items: [{ step: "call Bearer private.plan.token", status: "in_progress" }] }),
      event(2, "task_failure", { message: `Bearer secret.token.value ${"x".repeat(3_000)}` }),
    ]);
    const exported = createDiagnosticExport(report);
    const serialized = JSON.stringify(exported);
    expect(serialized).not.toContain("sk-super-secret");
    expect(serialized).not.toContain("secret.token.value");
    expect(serialized).not.toContain("title-secret");
    expect(serialized).not.toContain("private.plan.token");
    expect(exported.timeline[0]!.detail.length).toBeLessThanOrEqual(2_000);
  });

  it("reports permission friction, unfinished planning, and context growth without claiming semantic quality", () => {
    const report = analyzeAgentTask(task, [
      event(1, "agent_plan_update", { items: [{ step: "实现结算", status: "in_progress" }] }),
      event(2, "permission_requested", { request: { description: "访问网络" } }),
      event(3, "permission_requested", { request: { description: "运行测试" } }),
      event(4, "permission_requested", { request: { description: "读取文件" } }),
      event(5, "permission_requested", { request: { description: "写入文件" } }),
      event(6, "agent_usage", { inputTokens: 1000, outputTokens: 100 }),
      event(7, "agent_usage", { inputTokens: 1800, outputTokens: 100 }),
      event(8, "agent_usage", { inputTokens: 3500, outputTokens: 100 }),
      event(9, "agent_usage", { inputTokens: 9000, outputTokens: 100 }),
    ]);

    const codes = report.alerts.map((item) => item.code);
    expect(codes).toContain("permission_friction");
    expect(codes).toContain("unfinished_plan");
    expect(codes).toContain("context_growth");
    expect(report.scores.find((item) => item.dimension === "completion")?.score).toBe(100);
    expect(report.limitations.join(" ")).toContain("外部评审");
  });

  it("counts every model usage turn, uses the latest successful TTFT, and deduplicates failure incidents", () => {
    const events = [
      { ...event(1, "agent_status", { phase: "waiting_model" }, 1), runId: "failed-run" },
      { ...event(2, "agent_error", { message: "API 400" }, 500), runId: "failed-run" },
      { ...event(3, "task_failure", { message: "API 400" }, 501), runId: "failed-run" },
      { ...event(4, "task_failed", { error: "API 400" }, 502), runId: "failed-run" },
      { ...event(5, "agent_status", { phase: "waiting_model" }, 510), runId: "successful-run" },
      { ...event(6, "agent_stream_signal", { signal: "text" }, 512), runId: "successful-run" },
      ...Array.from({ length: 12 }, (_, index) => ({
        ...event(7 + index, "agent_usage", { inputTokens: 100, outputTokens: 10 }, 513 + index),
        runId: "successful-run",
      })),
    ];

    const report = analyzeAgentTask(task, events, { totalEventCount: 130_088 });

    expect(report.metrics.eventCount).toBe(130_088);
    expect(report.metrics.analyzedEventCount).toBe(events.length);
    expect(report.metrics.modelTurns).toBe(12);
    expect(report.metrics.firstSignalMs).toBe(2_000);
    expect(report.metrics.failureIncidents).toBe(1);
    expect(report.alerts.find((item) => item.code === "runtime_failure")?.detail).toContain("1 次独立失败");
  });

  it("treats an iteration boundary as resumable evidence instead of a runtime crash", () => {
    const pausedTask = { ...task, status: "paused" as const };
    const report = analyzeAgentTask(pausedTask, [
      event(1, "agent_error", { error: "Agent loop exceeded 80 iterations." }),
      event(2, "task_failure", { message: "Agent loop exceeded 80 iterations." }),
      event(3, "task_failed", { error: "Agent loop exceeded 80 iterations." }),
      event(4, "run_budget_boundary", { usedThisRun: 80, remainingTaskTurns: 80 }),
    ]);

    expect(report.metrics.failureIncidents).toBe(0);
    expect(report.alerts.some((item) => item.code === "runtime_failure")).toBe(false);
    expect(report.alerts.some((item) => item.code === "run_budget_boundary")).toBe(true);
  });

  it("reports a running tool that has not returned for over one minute", () => {
    const runningTask = {
      ...task,
      status: "running" as const,
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const report = analyzeAgentTask(runningTask, [{
      ...event(1, "agent_tool_start", {
        toolId: "hung-test",
        toolName: "bash",
        input: { command: "npm test" },
      }),
      createdAt: new Date(Date.now() - 90_000).toISOString(),
    }]);

    expect(report.alerts.find((item) => item.code === "tool_stalled")).toMatchObject({
      severity: "critical",
      title: "工具执行长时间没有返回",
    });
  });
});
