import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { analyzeAgentTask, createDiagnosticExport } from "../src/observability/agent-monitor.js";
import type { TaskEventRecord, TaskRecord, TaskStatus } from "../src/storage/agent-database.js";

interface TaskRow {
  id: string;
  project_id: string;
  session_id: string | null;
  title: string;
  goal: string;
  status: TaskStatus;
  checkpoint_json: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  revision: number;
  primary_path: string;
}

interface EventRow {
  id: number;
  task_id: string;
  run_id: string | null;
  event_type: string;
  payload_json: string;
  created_at: string;
}

const args = process.argv.slice(2);
const value = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const databaseFile = path.resolve(value("--db") ?? path.join(os.homedir(), ".allycode", "agent-state.sqlite"));
const outputFile = path.resolve(value("--output") ?? path.join(process.cwd(), "output", "latest-agent-monitor-audit.json"));
const database = new DatabaseSync(databaseFile, { readOnly: true });
const selectedTask = value("--task");
const row = (selectedTask
  ? database.prepare(`
      SELECT t.*, p.primary_path FROM tasks t
      JOIN projects p ON p.id = t.project_id WHERE t.id = ?
    `).get(selectedTask)
  : database.prepare(`
      SELECT t.*, p.primary_path FROM tasks t
      JOIN projects p ON p.id = t.project_id ORDER BY t.updated_at DESC LIMIT 1
    `).get()) as unknown as TaskRow | undefined;

if (!row) throw new Error("没有找到可审计任务。");

const task: TaskRecord = {
  id: row.id,
  projectId: row.project_id,
  sessionId: row.session_id ?? undefined,
  title: row.title,
  goal: row.goal,
  status: row.status,
  checkpoint: parseJson(row.checkpoint_json) as TaskRecord["checkpoint"],
  lastError: row.last_error ?? undefined,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  startedAt: row.started_at ?? undefined,
  completedAt: row.completed_at ?? undefined,
  revision: row.revision,
};

const eventTypeRows = database.prepare(`
  SELECT event_type, COUNT(*) AS count,
         SUM(LENGTH(payload_json)) AS payload_chars,
         MIN(id) AS first_id, MAX(id) AS last_id
  FROM task_events WHERE task_id = ?
  GROUP BY event_type ORDER BY count DESC
`).all(row.id) as unknown as Array<Record<string, string | number>>;
const totalEvents = eventTypeRows.reduce((sum, item) => sum + Number(item["count"]), 0);

// Text/thinking deltas can dominate long tasks and may contain project content.
// The deterministic monitor only needs structured lifecycle/tool/usage events.
const eventRows = database.prepare(`
  SELECT * FROM task_events
  WHERE task_id = ?
    AND event_type NOT IN ('agent_text_delta', 'agent_thinking_delta')
  ORDER BY id ASC
`).all(row.id) as unknown as EventRow[];
const events: TaskEventRecord[] = eventRows.map((event) => ({
  id: event.id,
  taskId: event.task_id,
  runId: event.run_id ?? undefined,
  eventType: event.event_type,
  payload: parseJson(event.payload_json),
  createdAt: event.created_at,
}));

const report = analyzeAgentTask(task, events);
report.metrics.eventCount = totalEvents;
const exported = createDiagnosticExport(report);
const toolNames = new Map<string, number>();
const touchedPaths = new Map<string, number>();
const statusCounts = new Map<string, number>();
const runSummaries = new Map<string, {
  firstAt: string;
  lastAt: string;
  toolCalls: number;
  usageEvents: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  errors: number;
}>();
for (const event of events) {
  const payload = object(event.payload);
  if (event.eventType === "agent_status") {
    const phase = typeof payload["phase"] === "string" ? payload["phase"] : "unknown";
    statusCounts.set(phase, (statusCounts.get(phase) ?? 0) + 1);
  }
  if (event.runId) {
    const summary = runSummaries.get(event.runId) ?? {
      firstAt: event.createdAt,
      lastAt: event.createdAt,
      toolCalls: 0,
      usageEvents: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      errors: 0,
    };
    summary.lastAt = event.createdAt;
    if (event.eventType === "agent_tool_start") summary.toolCalls += 1;
    if (event.eventType === "agent_usage") {
      summary.usageEvents += 1;
      summary.inputTokens += numeric(payload["inputTokens"]);
      summary.outputTokens += numeric(payload["outputTokens"]);
      summary.cacheReadTokens += numeric(payload["cacheReadTokens"]);
    }
    if (["agent_error", "task_failure", "task_failed"].includes(event.eventType)) summary.errors += 1;
    runSummaries.set(event.runId, summary);
  }
  if (event.eventType !== "agent_tool_start") continue;
  const toolName = typeof payload["toolName"] === "string" ? payload["toolName"] : "unknown";
  toolNames.set(toolName, (toolNames.get(toolName) ?? 0) + 1);
  const input = object(payload["input"]);
  const filePath = typeof input["path"] === "string" ? input["path"] : undefined;
  if (filePath) touchedPaths.set(filePath, (touchedPaths.get(filePath) ?? 0) + 1);
}

const audit = {
  ...exported,
  localEvidence: {
    projectPath: row.primary_path,
    persistedEventCount: totalEvents,
    analyzedStructuredEventCount: events.length,
    excludedSensitiveDeltaTypes: ["agent_text_delta", "agent_thinking_delta"],
    eventTypes: eventTypeRows,
    statusCounts: [...statusCounts].sort((a, b) => b[1] - a[1]).map(([phase, count]) => ({ phase, count })),
    runSummaries: [...runSummaries].map(([runId, summary]) => ({ runId, ...summary })),
    errorEvents: events
      .filter((event) => ["agent_error", "task_failure", "task_failed"].includes(event.eventType))
      .map((event) => ({
        id: event.id,
        runId: event.runId,
        type: event.eventType,
        createdAt: event.createdAt,
        detail: redact(JSON.stringify(event.payload)).slice(0, 1_000),
      })),
    toolCallsByName: [...toolNames].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
    mostTouchedPaths: [...touchedPaths].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([filePath, count]) => ({ path: filePath, count })),
  },
};

await fs.mkdir(path.dirname(outputFile), { recursive: true });
await fs.writeFile(outputFile, JSON.stringify(audit, null, 2), "utf8");
database.close();
console.log(JSON.stringify({
  task: audit.task,
  metrics: audit.metrics,
  scores: audit.scores,
  alerts: audit.alerts,
  localEvidence: audit.localEvidence,
  outputFile,
}, null, 2));

function parseJson(raw: string | null): unknown {
  if (!raw) return undefined;
  try { return JSON.parse(raw) as unknown; } catch { return raw; }
}

function object(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

function numeric(input: unknown): number {
  return typeof input === "number" && Number.isFinite(input) ? input : 0;
}

function redact(input: string): string {
  return input
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_API_KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:api[_-]?key|token|secret)=)[^&\s]+/gi, "$1[REDACTED]");
}
