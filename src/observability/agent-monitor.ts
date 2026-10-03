import crypto from "node:crypto";
import type { TaskEventRecord, TaskRecord } from "../storage/agent-database.js";
import type { PlanUpdateInput } from "../types/tools.js";

export type MonitorSeverity = "info" | "warning" | "critical";
export type MonitorDimension =
  | "completion"
  | "planning"
  | "tools"
  | "evidence"
  | "continuity"
  | "safety"
  | "efficiency";

export interface MonitorAlert {
  id: string;
  severity: MonitorSeverity;
  code: string;
  title: string;
  detail: string;
  evidenceEventIds: number[];
}

export interface MonitorScore {
  dimension: MonitorDimension;
  label: string;
  score: number | null;
  status: "measured" | "not_evaluated";
  evidence: string;
}

export interface MonitorTimelineItem {
  id: number;
  createdAt: string;
  category: "task" | "model" | "plan" | "tool" | "permission" | "checkpoint" | "error";
  severity: MonitorSeverity;
  title: string;
  detail: string;
}

export interface AgentMonitorReport {
  schemaVersion: 1;
  generatedAt: string;
  task: {
    id: string;
    title: string;
    goal: string;
    status: TaskRecord["status"];
    createdAt: string;
    updatedAt: string;
    engine?: string;
    engineVersion?: string;
    engineMaturity?: string;
    provider?: string;
    model?: string;
    protocol?: string;
  };
  metrics: {
    eventCount: number;
    analyzedEventCount: number;
    runCount: number;
    durationMs: number;
    modelTurns: number;
    auxiliaryModelCalls?: number;
    unknownUsageCalls?: number;
    firstSignalMs: number | null;
    toolCalls: number;
    toolSuccesses: number;
    toolErrors: number;
    toolDenied: number;
    permissionRequests: number;
    planUpdates: number;
    completedPlanItems: number;
    totalPlanItems: number;
    checkpoints: number;
    recoveries: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    cacheReadRate: number | null;
    failureIncidents: number;
  };
  currentPlan: PlanUpdateInput["items"];
  scores: MonitorScore[];
  alerts: MonitorAlert[];
  timeline: MonitorTimelineItem[];
  limitations: string[];
}

interface ToolObservation {
  eventId: number;
  startedAt: string;
  toolId: string;
  name: string;
  signature: string;
  input: Record<string, unknown>;
  result?: { eventId: number; isError: boolean; content: string };
  denied: boolean;
}

export function analyzeAgentTask(
  task: TaskRecord,
  events: TaskEventRecord[],
  options: { totalEventCount?: number } = {},
): AgentMonitorReport {
  const ordered = [...events].sort((a, b) => a.id - b.id);
  const runIds = new Set(ordered.map((event) => event.runId).filter(Boolean));
  const context = lastPayload(ordered, "agent_run_context");
  const usageEvents = ordered.filter((event) => event.eventType === "agent_usage");
  const toolObservations = collectTools(ordered);
  const planEvents = ordered.filter((event) => event.eventType === "agent_plan_update");
  const currentPlan = readPlan(planEvents.at(-1)?.payload) ?? task.checkpoint?.plan ?? [];
  const failureIncidents = collectFailureIncidents(ordered);
  const alerts = detectAlerts(task, ordered, toolObservations, currentPlan, planEvents.length, failureIncidents);
  const modelFailures = new Map<string,{id:number;record:Record<string,unknown>}>();
  for(const event of ordered) if(event.eventType==="agent_model_call") {
    const call=record(record(event.payload)["record"]);
    if(typeof call["id"] === "string") modelFailures.set(call["id"],{id:event.id,record:call});
  }
  const auxiliaryFailures=[...modelFailures.values()].filter(item=>item.record["purpose"]!=="main" && typeof item.record["failureKind"]==="string");
  if(auxiliaryFailures.length) {
    const reasoningLimited=auxiliaryFailures.filter(item=>record(item.record["diagnostic"])["code"]==="reasoning_only_limit").length;
    alerts.push({id:"auxiliary-model-failures",severity:"warning",code:"AUXILIARY_MODEL_FAILURE",title:"辅助模型调用需要检查",detail:`${auxiliaryFailures.length} 次辅助调用失败；其中 ${reasoningLimited} 次已确认达到输出上限但仅返回推理、没有可用正文。有 usage 的失败仍计量，无 usage 的费用保持未知；不代表主任务必然失败。`,evidenceEventIds:auxiliaryFailures.map(item=>item.id)});
  }
  const metrics = buildMetrics(task, ordered, runIds.size, usageEvents, toolObservations, currentPlan, planEvents.length, options.totalEventCount, failureIncidents.length);
  const scores = buildScores(task, metrics, toolObservations, alerts, currentPlan);

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    task: {
      id: task.id,
      title: task.title,
      goal: task.goal,
      status: task.status,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      engine: stringValue(context, "engine"),
      engineVersion: stringValue(context, "engineVersion"),
      engineMaturity: stringValue(context, "engineMaturity"),
      provider: stringValue(context, "provider"),
      model: stringValue(context, "model"),
      protocol: stringValue(context, "protocol"),
    },
    metrics,
    currentPlan,
    scores,
    alerts,
    timeline: ordered.slice(-500).map(toTimelineItem),
    limitations: [
      "评分来自可观测事件与确定性规则，不等同于 SWE-bench、人工代码审查或业务验收。",
      "目标语义漂移需要参考需求和产物进行外部评审；检测台只报告可证明的行为信号。",
      "隐藏思维不会被记录或展示；模型文字说明不能替代工具和测试证据。",
      "缓存指标只反映 Provider 实际上报的数据，0 不能证明 Provider 不支持缓存。",
    ],
  };
}

export function createDiagnosticExport(report: AgentMonitorReport): AgentMonitorReport {
  return {
    ...structuredClone(report),
    task: {
      ...report.task,
      title: redactText(report.task.title, 500),
      goal: redactText(report.task.goal, 2_000),
    },
    currentPlan: report.currentPlan.map((item) => ({
      ...item,
      step: redactText(item.step, 1_000),
    })),
    alerts: report.alerts.map((alert) => ({
      ...alert,
      detail: redactText(alert.detail, 2_000),
    })),
    timeline: report.timeline.map((item) => ({
      ...item,
      detail: redactText(item.detail, 2_000),
    })),
  };
}

function buildMetrics(
  task: TaskRecord,
  events: TaskEventRecord[],
  runCount: number,
  usageEvents: TaskEventRecord[],
  tools: ToolObservation[],
  currentPlan: PlanUpdateInput["items"],
  planUpdates: number,
  totalEventCount: number | undefined,
  failureIncidents: number,
): AgentMonitorReport["metrics"] {
  const totals = usageEvents.reduce((sum, event) => {
    const payload = record(event.payload);
    sum.input += numberValue(payload, "inputTokens");
    sum.output += numberValue(payload, "outputTokens");
    sum.cacheRead += numberValue(payload, "cacheReadTokens");
    sum.cacheWrite += numberValue(payload, "cacheWriteTokens");
    return sum;
  }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const started = Date.parse(task.startedAt ?? task.createdAt);
  const ended = Date.parse(task.completedAt ?? task.updatedAt);
  const modelWaits = events.filter((event) =>
    event.eventType === "agent_status" &&
    ["waiting_model", "waiting_model_after_tool"].includes(stringValue(event.payload, "phase") ?? "")
  );
  const firstSignalLatency = latestSuccessfulFirstSignalLatency(events);
  return {
    eventCount: totalEventCount ?? events.length,
    analyzedEventCount: events.length,
    runCount,
    durationMs: Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : 0,
    modelTurns: usageEvents.length > 0 ? usageEvents.filter((event) => !stringValue(event.payload, "purpose") || stringValue(event.payload, "purpose") === "main").length : modelWaits.length,
    auxiliaryModelCalls: usageEvents.filter((event) => stringValue(event.payload, "purpose") && stringValue(event.payload, "purpose") !== "main").length,
    unknownUsageCalls: events.filter((event) => event.eventType === "agent_model_call" && stringValue(record(event.payload)["record"], "status") === "unknown").length,
    firstSignalMs: firstSignalLatency,
    toolCalls: tools.length,
    toolSuccesses: tools.filter((tool) => tool.result && !tool.result.isError).length,
    toolErrors: tools.filter((tool) => tool.result?.isError).length,
    toolDenied: tools.filter((tool) => tool.denied).length,
    permissionRequests: events.filter((event) => event.eventType === "permission_requested").length,
    planUpdates,
    completedPlanItems: currentPlan.filter((item) => item.status === "completed").length,
    totalPlanItems: currentPlan.length,
    checkpoints: events.filter((event) => event.eventType === "checkpoint_saved").length,
    recoveries: events.filter((event) => event.eventType === "task_recovered").length,
    inputTokens: totals.input,
    outputTokens: totals.output,
    cacheReadTokens: totals.cacheRead,
    cacheWriteTokens: totals.cacheWrite,
    cacheReadRate: totals.input + totals.cacheRead > 0
      ? totals.cacheRead / (totals.input + totals.cacheRead)
      : null,
    failureIncidents,
  };
}

function detectAlerts(
  task: TaskRecord,
  events: TaskEventRecord[],
  tools: ToolObservation[],
  currentPlan: PlanUpdateInput["items"],
  planUpdates: number,
  failureIncidents: TaskEventRecord[][],
): MonitorAlert[] {
  const alerts: MonitorAlert[] = [];
  const boundaryRunIds = iterationBoundaryRunIds(events);
  const gateEvent = events.filter((event) => event.eventType === "completion_verification").at(-1);
  const gatePayload = record(gateEvent?.payload);
  if (gateEvent && stringValue(gatePayload, "status") === "failed") {
    alerts.push(alert(
      "critical",
      "completion_gate_failed",
      "独立完成门禁未通过",
      stringValue(gatePayload, "summary") ?? "模型已停止，但缺少可验证的工程完成证据。",
      [gateEvent.id],
    ));
  }
  const failures = events.filter((event) =>
    (event.eventType === "task_failed" || event.eventType === "task_failure" || event.eventType === "agent_error") &&
    !isIterationBoundaryFailure(event) &&
    !(event.runId && boundaryRunIds.has(event.runId))
  );
  if (failures.length > 0) {
    alerts.push(alert("critical", "runtime_failure", "运行发生错误", `${failureIncidents.length} 次独立失败（由 ${failures.length} 条关联事件归并）；查看时间线中的失败证据。`, failures.map((event) => event.id)));
  }
  if (task.status === "running" || task.status === "waiting_permission") {
    const stalled = tools.filter((tool) =>
      !tool.result &&
      !tool.denied &&
      Date.now() - Date.parse(tool.startedAt) >= 60_000
    );
    if (stalled.length > 0) {
      const oldest = stalled.reduce((left, right) =>
        Date.parse(left.startedAt) <= Date.parse(right.startedAt) ? left : right
      );
      const seconds = Math.floor((Date.now() - Date.parse(oldest.startedAt)) / 1_000);
      alerts.push(alert(
        "critical",
        "tool_stalled",
        "工具执行长时间没有返回",
        `${oldest.name} 已运行约 ${seconds} 秒且没有结果。应允许超时机制终止进程树，禁止无限等待或重复启动。`,
        stalled.map((tool) => tool.eventId),
      ));
    }
  }
  const budgetBoundaries = events.filter((event) =>
    event.eventType === "run_budget_boundary" || isIterationBoundaryFailure(event)
  );
  if (budgetBoundaries.length > 0) {
    alerts.push(alert(
      "warning",
      "run_budget_boundary",
      "本轮执行达到安全边界",
      "这不是完成证据。进度应已保存，需从检查点继续并完成独立验收。",
      budgetBoundaries.map((event) => event.id),
    ));
  }

  const signatureGroups = new Map<string, ToolObservation[]>();
  for (const tool of tools) {
    const group = signatureGroups.get(tool.signature) ?? [];
    group.push(tool);
    signatureGroups.set(tool.signature, group);
  }
  for (const group of signatureGroups.values()) {
    if (group.length < 3) continue;
    alerts.push(alert("warning", "repeated_tool", "可能存在重复操作", `${group[0]!.name} 使用相同参数调用 ${group.length} 次。`, group.map((item) => item.eventId)));
  }

  const consecutiveErrors = longestConsecutiveToolErrors(tools);
  if (consecutiveErrors.length >= 3) {
    alerts.push(alert("critical", "tool_error_loop", "工具错误连续发生", `连续 ${consecutiveErrors.length} 个工具调用失败，可能正在无进展重试。`, consecutiveErrors.map((item) => item.result!.eventId)));
  }

  if (tools.length >= 4 && planUpdates === 0) {
    alerts.push(alert("warning", "missing_plan", "复杂执行没有可见计划", `已执行 ${tools.length} 个工具，但没有 plan_update 事件，长任务偏航风险较高。`, tools.slice(0, 4).map((item) => item.eventId)));
  }
  if (
    tools.length >= 12 &&
    currentPlan.length > 0 &&
    planUpdates <= 1 &&
    currentPlan.every((item) => item.status !== "completed")
  ) {
    alerts.push(alert(
      "warning",
      "stale_plan",
      "执行计划长期未同步",
      `已调用 ${tools.length} 次工具，但计划只更新 ${planUpdates} 次且没有步骤标记完成。计划状态不能代表真实进度。`,
      events.filter((event) => event.eventType === "agent_plan_update").slice(-1).map((event) => event.id),
    ));
  }

  if (task.status === "completed" && currentPlan.some((item) => item.status !== "completed")) {
    alerts.push(alert("warning", "unfinished_plan", "完成状态与计划不一致", "任务已标记完成，但工作计划仍有未完成步骤。", events.filter((event) => event.eventType === "agent_plan_update").slice(-1).map((event) => event.id)));
  }

  const mutations = tools.filter((tool) => ["file_write", "file_edit", "git_commit"].includes(tool.name) && !tool.result?.isError);
  const verification = tools.filter((tool) => tool.name === "bash" && isVerificationCommand(tool.input) && !tool.result?.isError);
  if (task.status === "completed" && mutations.length > 0 && verification.length === 0) {
    alerts.push(alert("warning", "unverified_change", "代码改动缺少验证证据", `检测到 ${mutations.length} 次成功写入，但未检测到成功的测试、构建、Lint 或类型检查命令。`, mutations.map((item) => item.eventId)));
  }

  const permissionByTool = new Map<string, TaskEventRecord[]>();
  for (const event of events.filter((item) => item.eventType === "permission_requested")) {
    const request = record(record(event.payload)["request"]);
    const toolName = stringValue(request, "toolName") ?? "unknown";
    const group = permissionByTool.get(toolName) ?? [];
    group.push(event);
    permissionByTool.set(toolName, group);
  }
  for (const [toolName, group] of permissionByTool) {
    if (group.length >= 4) alerts.push(alert("warning", "permission_friction", "权限确认过于频繁", `${toolName} 在同一任务请求确认 ${group.length} 次。`, group.map((event) => event.id)));
  }

  const usage = events.filter((event) => event.eventType === "agent_usage").map((event) => numberValue(event.payload, "inputTokens"));
  if (usage.length >= 4 && usage.at(-1)! > Math.max(8_000, usage[0]! * 3)) {
    alerts.push(alert("warning", "context_growth", "上下文增长较快", `单轮输入从 ${usage[0]!.toLocaleString()} 增长到 ${usage.at(-1)!.toLocaleString()} tokens。`, events.filter((event) => event.eventType === "agent_usage").slice(-4).map((event) => event.id)));
  }
  return alerts;
}

function buildScores(
  task: TaskRecord,
  metrics: AgentMonitorReport["metrics"],
  tools: ToolObservation[],
  alerts: MonitorAlert[],
  plan: PlanUpdateInput["items"],
): MonitorScore[] {
  const hasCritical = alerts.some((item) => item.severity === "critical");
  const mutations = tools.filter((tool) => ["file_write", "file_edit", "git_commit"].includes(tool.name) && !tool.result?.isError);
  const verified = tools.some((tool) => tool.name === "bash" && isVerificationCommand(tool.input) && !tool.result?.isError);
  const completionGateFailed = alerts.some((item) => item.code === "completion_gate_failed");
  const toolScore = metrics.toolCalls === 0
    ? null
    : Math.round(100 * metrics.toolSuccesses / Math.max(1, metrics.toolCalls - metrics.toolDenied));
  return [
    score("completion", "任务完成度", task.status === "completed" ? (hasCritical ? 40 : 100) : task.status === "failed" ? 0 : null, task.status === "completed" ? "任务运行到完成状态；仍需结合告警判断质量。" : `当前状态：${task.status}`),
    score("planning", "计划一致性", plan.length === 0 ? null : Math.round(100 * plan.filter((item) => item.status === "completed").length / plan.length), plan.length ? `${plan.filter((item) => item.status === "completed").length}/${plan.length} 个计划步骤完成。` : "没有足够计划事件，未评估。"),
    score("tools", "工具可靠性", toolScore, toolScore === null ? "任务尚未产生工具调用。" : `${metrics.toolSuccesses} 成功、${metrics.toolErrors} 失败、${metrics.toolDenied} 被拒绝。`),
    score("evidence", "证据完整性", mutations.length === 0 ? null : completionGateFailed ? 15 : verified ? 100 : 35, mutations.length === 0 ? "没有检测到代码写入，未评估工程验证。" : completionGateFailed ? "确定性完成门禁发现验证缺口。" : verified ? "代码写入后检测到成功验证命令。" : "存在写入，但没有成功测试/构建证据。"),
    score("continuity", "记忆与恢复", metrics.checkpoints > 0 ? (metrics.recoveries > 0 ? 90 : 100) : null, metrics.checkpoints > 0 ? `${metrics.checkpoints} 个检查点、${metrics.recoveries} 次崩溃恢复。` : "没有检查点证据，未评估。"),
    score("safety", "安全与授权", alerts.some((item) => item.code === "permission_friction") ? 65 : 100, `${metrics.permissionRequests} 次授权请求、${metrics.toolDenied} 次拒绝。此分数不代表插件供应链安全。`),
    score("efficiency", "成本与效率", efficiencyScore(metrics, alerts), metrics.inputTokens + metrics.outputTokens === 0 ? "Provider 未提供 token 数据。" : `模型 ${metrics.modelTurns} 轮；输入 ${metrics.inputTokens.toLocaleString()}、输出 ${metrics.outputTokens.toLocaleString()}、缓存读取 ${metrics.cacheReadTokens.toLocaleString()}。`),
  ];
}

function efficiencyScore(
  metrics: AgentMonitorReport["metrics"],
  alerts: MonitorAlert[],
): number | null {
  if (metrics.inputTokens + metrics.outputTokens === 0) return null;
  let value = 100;
  if (alerts.some((item) => item.code === "context_growth")) value -= 20;
  if (metrics.modelTurns > 50) value -= 15;
  if (metrics.modelTurns > 100) value -= 15;
  if (metrics.modelTurns > 200) value -= 15;
  if (metrics.outputTokens > 100_000) value -= 10;
  if (metrics.toolErrors > 0) value -= Math.min(15, metrics.toolErrors * 2);
  if (metrics.failureIncidents > 0) value -= Math.min(20, metrics.failureIncidents * 4);
  return Math.max(0, value);
}

function latestSuccessfulFirstSignalLatency(events: TaskEventRecord[]): number | null {
  const byRun = new Map<string, TaskEventRecord[]>();
  for (const event of events) {
    const runKey = event.runId ?? "__legacy__";
    const group = byRun.get(runKey) ?? [];
    group.push(event);
    byRun.set(runKey, group);
  }
  const candidates: Array<{ signalId: number; latency: number }> = [];
  for (const runEvents of byRun.values()) {
    const waiting = runEvents.find((event) => event.eventType === "agent_status" &&
      ["waiting_model", "waiting_model_after_tool"].includes(stringValue(event.payload, "phase") ?? ""));
    if (!waiting) continue;
    const signal = runEvents.find((event) => event.id > waiting.id && [
      "agent_stream_signal",
      "agent_text_delta",
      "agent_thinking_delta",
      "agent_tool_pending",
    ].includes(event.eventType));
    if (!signal) continue;
    candidates.push({
      signalId: signal.id,
      latency: Math.max(0, Date.parse(signal.createdAt) - Date.parse(waiting.createdAt)),
    });
  }
  return candidates.sort((a, b) => b.signalId - a.signalId)[0]?.latency ?? null;
}

function collectFailureIncidents(events: TaskEventRecord[]): TaskEventRecord[][] {
  const groups = new Map<string, TaskEventRecord[]>();
  const boundaryRunIds = iterationBoundaryRunIds(events);
  for (const event of events.filter((item) =>
    (item.eventType === "task_failed" || item.eventType === "task_failure" || item.eventType === "agent_error") &&
    !isIterationBoundaryFailure(item) &&
    !(item.runId && boundaryRunIds.has(item.runId))
  )) {
    const key = event.runId
      ? `run:${event.runId}`
      : `message:${extractError(record(event.payload)).replace(/\s+/g, " ").slice(0, 300)}`;
    const group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function isIterationBoundaryFailure(event: TaskEventRecord): boolean {
  return /Agent loop exceeded \d+ iterations/i.test(extractError(record(event.payload)));
}

function iterationBoundaryRunIds(events: TaskEventRecord[]): Set<string> {
  return new Set(events
    .filter((event) => event.runId && isIterationBoundaryFailure(event))
    .map((event) => event.runId!));
}

function collectTools(events: TaskEventRecord[]): ToolObservation[] {
  const tools: ToolObservation[] = [];
  const byId = new Map<string, ToolObservation>();
  for (const event of events) {
    if (event.eventType === "agent_tool_start") {
      const payload = record(event.payload);
      const toolId = stringValue(payload, "toolId") ?? `event-${event.id}`;
      const name = stringValue(payload, "toolName") ?? "unknown";
      const input = record(payload["input"]);
      const observation: ToolObservation = {
        eventId: event.id,
        startedAt: event.createdAt,
        toolId,
        name,
        input,
        signature: `${name}:${stableHash(input)}`,
        denied: false,
      };
      tools.push(observation);
      byId.set(toolId, observation);
    } else if (event.eventType === "agent_tool_result") {
      const payload = record(event.payload);
      const observation = byId.get(stringValue(payload, "toolId") ?? "");
      if (observation) observation.result = {
        eventId: event.id,
        isError: Boolean(payload["isError"]),
        content: stringValue(payload, "content") ?? "",
      };
    } else if (event.eventType === "agent_tool_denied") {
      const observation = byId.get(stringValue(event.payload, "toolId") ?? "");
      if (observation) observation.denied = true;
    }
  }
  return tools;
}

function toTimelineItem(event: TaskEventRecord): MonitorTimelineItem {
  const payload = record(event.payload);
  const type = event.eventType;
  if (type === "agent_tool_start") return timeline(event, "tool", "info", `开始工具：${stringValue(payload, "toolName") ?? "unknown"}`, summarizeToolInput(record(payload["input"])));
  if (type === "agent_tool_result") {
    const toolName = stringValue(payload, "toolName") ?? "unknown";
    return timeline(event, "tool", payload["isError"] ? "warning" : "info", `${payload["isError"] ? "工具失败" : "工具完成"}：${toolName}`, summarizeToolResult(toolName, stringValue(payload, "content") ?? ""));
  }
  if (type === "agent_plan_update") return timeline(event, "plan", "info", "工作计划更新", `${readPlan(payload)?.length ?? 0} 个步骤`);
  if (type === "agent_usage") return timeline(event, "model", "info", "模型用量", `输入 ${numberValue(payload, "inputTokens")} · 输出 ${numberValue(payload, "outputTokens")} · 缓存读取 ${numberValue(payload, "cacheReadTokens")}`);
  if (type === "agent_status") return timeline(event, "model", "info", "Agent 状态", stringValue(payload, "phase") ?? "unknown");
  if (type === "permission_requested") return timeline(event, "permission", "warning", "等待用户授权", stringValue(record(record(payload)["request"]), "description") ?? "外部操作需要确认");
  if (type === "permission_resolved") return timeline(event, "permission", "info", "授权已处理", stringValue(payload, "decision") ?? "unknown");
  if (type === "checkpoint_saved") return timeline(event, "checkpoint", "info", "检查点已保存", stringValue(payload, "note") ?? stringValue(payload, "reason") ?? "");
  if (type === "completion_verification") return timeline(event, "task", stringValue(payload, "status") === "failed" ? "critical" : "info", "独立完成门禁", stringValue(payload, "summary") ?? "");
  if (type.includes("error") || type.includes("failure") || type === "task_failed") return timeline(event, "error", "critical", "运行错误", extractError(payload));
  if (type.startsWith("task_")) return timeline(event, "task", type === "task_failed" ? "critical" : "info", taskEventLabel(type), stringValue(payload, "note") ?? "");
  if (type === "agent_run_context") return timeline(event, "model", "info", "运行环境", `${stringValue(payload, "engine") ?? "native"} · ${stringValue(payload, "provider") ?? "?"} · ${stringValue(payload, "model") ?? "?"} · ${stringValue(payload, "protocol") ?? "auto"}`);
  if (type === "agent_engine_health") return timeline(event, "model", stringValue(payload, "state") === "ready" ? "info" : "warning", "引擎健康检查", `${stringValue(record(payload)["engine"], "name") ?? "外部引擎"} · ${stringValue(payload, "state") ?? "unknown"}`);
  if (type === "agent_engine_fallback") return timeline(event, "model", "warning", "引擎已回退", `${stringValue(payload, "requestedEngine") ?? "external"} → ${stringValue(payload, "resolvedEngine") ?? "native"}：${stringValue(payload, "reason") ?? "不可用"}`);
  return timeline(event, "task", "info", type, "");
}

function alert(severity: MonitorSeverity, code: string, title: string, detail: string, evidenceEventIds: number[]): MonitorAlert {
  return { id: `${code}-${evidenceEventIds[0] ?? 0}`, severity, code, title, detail, evidenceEventIds };
}

function score(dimension: MonitorDimension, label: string, value: number | null, evidence: string): MonitorScore {
  return { dimension, label, score: value === null ? null : Math.max(0, Math.min(100, value)), status: value === null ? "not_evaluated" : "measured", evidence };
}

function timeline(event: TaskEventRecord, category: MonitorTimelineItem["category"], severity: MonitorSeverity, title: string, detail: string): MonitorTimelineItem {
  return { id: event.id, createdAt: event.createdAt, category, severity, title, detail: redactText(detail, 2_000) };
}

function longestConsecutiveToolErrors(tools: ToolObservation[]): ToolObservation[] {
  let longest: ToolObservation[] = [];
  let current: ToolObservation[] = [];
  for (const tool of tools) {
    if (tool.result?.isError) {
      current.push(tool);
      if (current.length > longest.length) longest = [...current];
    } else current = [];
  }
  return longest;
}

function isVerificationCommand(input: Record<string, unknown>): boolean {
  const command = stringValue(input, "command") ?? "";
  return /(?:^|\s)(?:npm|pnpm|yarn)\s+(?:test|run\s+(?:test|build|lint|typecheck))\b|\b(?:pytest|vitest|jest|cargo\s+test|go\s+test|dotnet\s+test|tsc\b)/i.test(command);
}

function readPlan(payload: unknown): PlanUpdateInput["items"] | undefined {
  const items = record(payload)["items"];
  if (!Array.isArray(items)) return undefined;
  const parsed = items.flatMap((item) => {
    const value = record(item);
    const step = stringValue(value, "step");
    const status = stringValue(value, "status");
    return step && ["pending", "in_progress", "completed"].includes(status ?? "")
      ? [{ step, status: status as PlanUpdateInput["items"][number]["status"] }]
      : [];
  });
  return parsed;
}

function lastPayload(events: TaskEventRecord[], type: string): Record<string, unknown> {
  return record(events.filter((event) => event.eventType === type).at(-1)?.payload);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown, key: string): string | undefined {
  const nested = record(value)[key];
  return typeof nested === "string" ? nested : undefined;
}

function numberValue(value: unknown, key: string): number {
  const nested = record(value)[key];
  return typeof nested === "number" && Number.isFinite(nested) ? nested : 0;
}

function stableHash(input: Record<string, unknown>): string {
  return crypto.createHash("sha256").update(stableStringify(input)).digest("hex").slice(0, 16);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function summarizeToolInput(input: Record<string, unknown>): string {
  if (typeof input["path"] === "string") return `路径：${redactText(input["path"], 500)}`;
  if (typeof input["command"] === "string") return `命令：${redactText(input["command"], 500)}`;
  if (typeof input["query"] === "string") return `查询：${redactText(input["query"], 500)}`;
  return Object.keys(input).length ? `参数字段：${Object.keys(input).join("、")}` : "无参数";
}

function summarizeToolResult(toolName: string, content: string): string {
  const exit = /\[Exit code:\s*(-?\d+)\]/i.exec(content)?.[1];
  if (exit !== undefined) return `命令退出码：${exit}`;
  if (!content) return "无输出";
  if (["file_read", "file_write", "file_edit"].includes(toolName)) {
    return `文件操作已返回结果（内容不在检测台展示，${Buffer.byteLength(content, "utf8")} 字节）`;
  }
  return `工具已返回结果（内容不在检测台展示，${Buffer.byteLength(content, "utf8")} 字节）`;
}

function extractError(payload: Record<string, unknown>): string {
  const rawError = payload["error"];
  return stringValue(payload, "message") ??
    (typeof rawError === "string" ? rawError : undefined) ??
    stringValue(record(rawError), "message") ??
    "错误详情未序列化";
}

function taskEventLabel(type: string): string {
  return ({ task_created: "任务已创建", task_running: "任务运行中", task_paused: "任务已暂停", task_completed: "任务已完成", task_failed: "任务失败", task_recovered: "中断任务已恢复" } as Record<string, string>)[type] ?? type;
}

function redactText(text: string, maxLength: number): string {
  return text
    .replace(/\b(?:sk|pk|rk|api)[-_][A-Za-z0-9_-]{12,}\b/gi, "[REDACTED_KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:key|token|secret|password)=)[^&\s]+/gi, "$1[REDACTED]")
    .slice(0, maxLength);
}
