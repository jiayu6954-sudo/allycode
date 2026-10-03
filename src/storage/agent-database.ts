import crypto, { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { DATA_DIR } from "../config/settings.js";
import type { ConversationMessage, TokenUsage } from "../types/agent.js";
import { externalizeContinuation } from "./continuation-state.js";

// Keep the protocol out of the static bundle graph. Some Electron bundlers
// rewrite `node:sqlite` to the non-existent npm package `sqlite`.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:" + "sqlite") as typeof import("node:sqlite");

export const AGENT_DATABASE_FILE = path.join(DATA_DIR, "agent-state.sqlite");

export type TaskStatus =
  | "queued"
  | "running"
  | "waiting_permission"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface ProjectRecord {
  id: string;
  name: string;
  primaryPath: string;
  identityKey: string;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
}

export interface TaskCheckpoint {
  conversationHistory: ConversationMessage[];
  reason: "initial" | "iteration" | "permission" | "paused" | "completed" | "failed";
  usage?: TokenUsage;
  note?: string;
  plan?: import("../types/tools.js").PlanUpdateInput["items"];
  compactionState?: import("../agent/context-compaction.js").CompactionState;
}

export interface TaskRecord {
  id: string;
  projectId: string;
  sessionId?: string;
  title: string;
  goal: string;
  status: TaskStatus;
  checkpoint?: TaskCheckpoint;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  revision: number;
}

export interface TaskEventRecord {
  id: number;
  taskId: string;
  runId?: string;
  eventType: string;
  payload: unknown;
  createdAt: string;
}

export interface SessionDeletionResult {
  detachedTaskCount: number;
  deletedTaskCount: number;
  deletedEventCount: number;
}

interface ProjectRow {
  id: string;
  name: string;
  primary_path: string;
  identity_key: string;
  created_at: string;
  updated_at: string;
  last_opened_at: string;
}

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
}

interface TaskEventRow {
  id: number;
  task_id: string;
  run_id: string | null;
  event_type: string;
  payload_json: string;
  created_at: string;
}

/**
 * Durable local state for projects and autonomous tasks.
 *
 * The database uses WAL so UI reads do not block frequent checkpoint writes.
 * All public mutation methods are synchronous transactions: when they return,
 * the state required for crash recovery is already committed locally.
 */
export class AgentDatabase {
  private readonly db: DatabaseSyncType;

  constructor(filePath = AGENT_DATABASE_FILE) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  resolveProject(projectPath: string): ProjectRecord {
    const resolvedPath = path.resolve(projectPath);
    const normalizedPath = normalizeProjectPath(resolvedPath);
    const now = new Date().toISOString();

    const byPath = this.db.prepare(`
      SELECT p.*
      FROM projects p
      JOIN project_paths pp ON pp.project_id = p.id
      WHERE pp.normalized_path = ?
    `).get(normalizedPath) as ProjectRow | undefined;

    if (byPath) {
      this.db.prepare(`
        UPDATE projects
        SET primary_path = ?, name = ?, updated_at = ?, last_opened_at = ?
        WHERE id = ?
      `).run(resolvedPath, path.basename(resolvedPath), now, now, byPath.id);
      this.db.prepare(`UPDATE project_paths SET last_seen_at = ? WHERE normalized_path = ?`)
        .run(now, normalizedPath);
      return this.getProject(byPath.id)!;
    }

    const identityKey = deriveProjectIdentityKey(resolvedPath);
    const byIdentity = this.db
      .prepare("SELECT * FROM projects WHERE identity_key = ?")
      .get(identityKey) as ProjectRow | undefined;

    const projectId = byIdentity?.id ?? randomUUID();
    this.transaction(() => {
      if (byIdentity) {
        this.db.prepare(`
          UPDATE projects
          SET primary_path = ?, name = ?, updated_at = ?, last_opened_at = ?
          WHERE id = ?
        `).run(resolvedPath, path.basename(resolvedPath), now, now, projectId);
      } else {
        this.db.prepare(`
          INSERT INTO projects (
            id, name, primary_path, identity_key, created_at, updated_at, last_opened_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          projectId,
          path.basename(resolvedPath),
          resolvedPath,
          identityKey,
          now,
          now,
          now,
        );
      }
      this.db.prepare(`
        INSERT INTO project_paths (normalized_path, project_id, path, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(normalized_path) DO UPDATE SET
          project_id = excluded.project_id,
          path = excluded.path,
          last_seen_at = excluded.last_seen_at
      `).run(normalizedPath, projectId, resolvedPath, now, now);
    });
    return this.getProject(projectId)!;
  }

  getProject(id: string): ProjectRecord | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as
      | ProjectRow
      | undefined;
    return row ? mapProject(row) : null;
  }

  createTask(input: {
    projectId: string;
    title: string;
    goal: string;
    sessionId?: string;
  }): TaskRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO tasks (
        id, project_id, session_id, title, goal, status,
        created_at, updated_at, revision
      ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, 0)
    `).run(
      id,
      input.projectId,
      input.sessionId ?? null,
      input.title,
      input.goal,
      now,
      now,
    );
    this.appendEvent(id, "task_created", {
      title: input.title,
      goal: input.goal,
      projectId: input.projectId,
    });
    return this.getTask(id)!;
  }

  getTask(id: string): TaskRecord | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | TaskRow
      | undefined;
    return row ? mapTask(row) : null;
  }

  listTasks(projectId?: string, limit = 100): TaskRecord[] {
    const boundedLimit = Math.max(1, Math.min(limit, 500));
    const rows = projectId
      ? this.db.prepare(`
          SELECT * FROM tasks WHERE project_id = ?
          ORDER BY updated_at DESC LIMIT ?
        `).all(projectId, boundedLimit)
      : this.db.prepare(`SELECT * FROM tasks ORDER BY updated_at DESC LIMIT ?`)
          .all(boundedLimit);
    return (rows as unknown as TaskRow[]).map(mapTask);
  }

  listTasksBySessionIds(sessionIds: string[]): TaskRecord[] {
    const ids = uniqueNonEmpty(sessionIds);
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db.prepare(`
      SELECT * FROM tasks
      WHERE session_id IN (${placeholders})
      ORDER BY updated_at DESC
    `).all(...ids) as unknown as TaskRow[];
    return rows.map(mapTask);
  }

  /**
   * Physically removes selected session links and, when explicitly requested,
   * their durable tasks/checkpoints/events. Project and long-term memory tables
   * are deliberately outside this transaction.
   */
  deleteSessionData(
    sessionIds: string[],
    includeDurableTasks: boolean,
  ): SessionDeletionResult {
    const ids = uniqueNonEmpty(sessionIds);
    if (ids.length === 0) {
      return { detachedTaskCount: 0, deletedTaskCount: 0, deletedEventCount: 0 };
    }
    const placeholders = ids.map(() => "?").join(", ");
    const tasks = this.listTasksBySessionIds(ids);
    const active = tasks.filter((task) =>
      task.status === "running" || task.status === "waiting_permission"
    );
    if (active.length > 0) {
      throw new Error("运行中或等待确认的任务不能删除，请先暂停任务。");
    }

    if (!includeDurableTasks) {
      const now = new Date().toISOString();
      return this.transaction(() => {
        const result = this.db.prepare(`
          UPDATE tasks
          SET session_id = NULL, updated_at = ?, revision = revision + 1
          WHERE session_id IN (${placeholders})
        `).run(now, ...ids);
        for (const task of tasks) {
          this.appendEvent(task.id, "session_deleted", {
            sessionId: task.sessionId,
            durableTaskPreserved: true,
          });
        }
        return {
          detachedTaskCount: Number(result.changes),
          deletedTaskCount: 0,
          deletedEventCount: 0,
        };
      });
    }

    const taskIds = tasks.map((task) => task.id);
    if (taskIds.length === 0) {
      return { detachedTaskCount: 0, deletedTaskCount: 0, deletedEventCount: 0 };
    }
    const taskPlaceholders = taskIds.map(() => "?").join(", ");
    return this.transaction(() => {
      const eventCount = this.db.prepare(`
        SELECT COUNT(*) AS count FROM task_events
        WHERE task_id IN (${taskPlaceholders})
      `).get(...taskIds) as { count: number };
      // FTS5 is not a foreign-key table, so its rows must be removed explicitly.
      this.db.prepare(`
        DELETE FROM task_event_search
        WHERE task_id IN (${taskPlaceholders})
      `).run(...taskIds);
      const deleted = this.db.prepare(`
        DELETE FROM tasks WHERE id IN (${taskPlaceholders})
      `).run(...taskIds);
      return {
        detachedTaskCount: 0,
        deletedTaskCount: Number(deleted.changes),
        deletedEventCount: eventCount.count,
      };
    });
  }

  attachSession(taskId: string, sessionId: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE tasks
      SET session_id = ?, updated_at = ?, revision = revision + 1
      WHERE id = ?
    `).run(sessionId, now, taskId);
  }

  updateTaskStatus(
    taskId: string,
    status: TaskStatus,
    options: { error?: string; runId?: string; note?: string } = {},
  ): void {
    const now = new Date().toISOString();
    const startedAt = status === "running" ? now : null;
    const completedAt = ["completed", "failed", "cancelled"].includes(status)
      ? now
      : null;
    this.db.prepare(`
      UPDATE tasks
      SET status = ?,
          last_error = ?,
          started_at = COALESCE(started_at, ?),
          completed_at = ?,
          updated_at = ?,
          revision = revision + 1
      WHERE id = ?
    `).run(
      status,
      options.error ?? null,
      startedAt,
      completedAt,
      now,
      taskId,
    );
    this.appendEvent(taskId, `task_${status}`, {
      note: options.note,
      error: options.error,
    }, options.runId);
  }

  checkpointTask(
    taskId: string,
    checkpoint: TaskCheckpoint,
    runId?: string,
  ): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE tasks
      SET checkpoint_json = ?, updated_at = ?, revision = revision + 1
      WHERE id = ?
    `).run(JSON.stringify({ ...checkpoint, conversationHistory: externalizeContinuation(checkpoint.conversationHistory) }), now, taskId);
    this.appendEvent(taskId, "checkpoint_saved", {
      reason: checkpoint.reason,
      messageCount: checkpoint.conversationHistory.length,
      note: checkpoint.note,
    }, runId);
  }

  appendEvent(
    taskId: string,
    eventType: string,
    payload: unknown,
    runId?: string,
  ): number {
    const now = new Date().toISOString();
    const payloadJson = safeJsonStringify(payload);
    const result = this.db.prepare(`
      INSERT INTO task_events (task_id, run_id, event_type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(taskId, runId ?? null, eventType, payloadJson, now);
    const eventId = Number(result.lastInsertRowid);
    if (isSearchableEventType(eventType)) {
      this.db.prepare(`
        INSERT INTO task_event_search (event_id, task_id, event_type, content)
        VALUES (?, ?, ?, ?)
      `).run(eventId, taskId, eventType, searchableText(payload));
    }
    return eventId;
  }

  listEvents(taskId: string, afterId = 0, limit = 500): TaskEventRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM task_events
      WHERE task_id = ? AND id > ?
      ORDER BY id ASC LIMIT ?
    `).all(taskId, afterId, Math.max(1, Math.min(limit, 2000))) as unknown as TaskEventRow[];
    return rows.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      runId: row.run_id ?? undefined,
      eventType: row.event_type,
      payload: safeJsonParse(row.payload_json),
      createdAt: row.created_at,
    }));
  }

  /** Complete, compact event stream used by the deterministic monitor. */
  listMonitorEvents(taskId: string): TaskEventRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM task_events
      WHERE task_id = ?
        AND event_type NOT IN (
          'agent_text_delta', 'agent_thinking_delta', 'agent_tool_progress'
        )
      ORDER BY id ASC
    `).all(taskId) as unknown as TaskEventRow[];
    return rows.map(mapTaskEvent);
  }

  countEvents(taskId: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS count FROM task_events WHERE task_id = ?",
    ).get(taskId) as { count: number };
    return row.count;
  }

  searchEvents(query: string, limit = 20, projectId?: string): TaskEventRecord[] {
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    let rows: TaskEventRow[] = [];
    try {
      rows = (projectId
        ? this.db.prepare(`
            SELECT e.*
            FROM task_event_search s
            JOIN task_events e ON e.id = s.event_id
            JOIN tasks t ON t.id = e.task_id
            WHERE task_event_search MATCH ? AND t.project_id = ?
            ORDER BY bm25(task_event_search), e.created_at DESC
            LIMIT ?
          `).all(query, projectId, boundedLimit)
        : this.db.prepare(`
            SELECT e.*
            FROM task_event_search s
            JOIN task_events e ON e.id = s.event_id
            WHERE task_event_search MATCH ?
            ORDER BY bm25(task_event_search), e.created_at DESC
            LIMIT ?
          `).all(query, boundedLimit)) as unknown as TaskEventRow[];
    } catch {
      // User text can contain FTS operators. The literal fallback below is safe.
    }
    if (rows.length === 0) {
      const like = `%${query.replace(/[%_]/g, "\\$&")}%`;
      rows = (projectId
        ? this.db.prepare(`
            SELECT e.* FROM task_events e
            JOIN tasks t ON t.id = e.task_id
            WHERE e.payload_json LIKE ? ESCAPE '\\' AND t.project_id = ?
            ORDER BY e.created_at DESC LIMIT ?
          `).all(like, projectId, boundedLimit)
        : this.db.prepare(`
            SELECT * FROM task_events
            WHERE payload_json LIKE ? ESCAPE '\\'
            ORDER BY created_at DESC LIMIT ?
          `).all(like, boundedLimit)) as unknown as TaskEventRow[];
    }
    return rows.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      runId: row.run_id ?? undefined,
      eventType: row.event_type,
      payload: safeJsonParse(row.payload_json),
      createdAt: row.created_at,
    }));
  }

  /** Mark runs left active by a crash as resumable rather than failed. */
  recoverInterruptedTasks(): number {
    const now = new Date().toISOString();
    const rows = this.db.prepare(`
      SELECT id FROM tasks WHERE status IN ('running', 'waiting_permission')
    `).all() as Array<{ id: string }>;
    this.transaction(() => {
      for (const row of rows) {
        this.db.prepare(`
          UPDATE tasks
          SET status = 'paused',
              updated_at = ?,
              revision = revision + 1
          WHERE id = ?
        `).run(now, row.id);
        this.appendEvent(row.id, "task_recovered", {
          reason: "The previous AllyCode process stopped before the task completed.",
        });
      }
    });
    return rows.length;
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        primary_path TEXT NOT NULL,
        identity_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_opened_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_paths (
        normalized_path TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        session_id TEXT,
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN (
          'queued', 'running', 'waiting_permission', 'paused',
          'completed', 'failed', 'cancelled'
        )),
        checkpoint_json TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        revision INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_project_updated
        ON tasks(project_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_status_updated
        ON tasks(status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        run_id TEXT,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_task_events_task_id
        ON task_events(task_id, id);

      CREATE VIRTUAL TABLE IF NOT EXISTS task_event_search USING fts5(
        event_id UNINDEXED,
        task_id UNINDEXED,
        event_type UNINDEXED,
        content,
        tokenize = 'unicode61'
      );

      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
      VALUES (1, datetime('now'));
    `);
  }
}

let sharedDatabase: AgentDatabase | undefined;

export function getAgentDatabase(): AgentDatabase {
  sharedDatabase ??= new AgentDatabase();
  return sharedDatabase;
}

/** Stable, privacy-preserving namespace for project memory and artifacts. */
export function stableProjectFingerprint(projectPath: string): string {
  const identityKey = deriveProjectIdentityKey(projectPath);
  if (identityKey.startsWith("path:")) {
    return crypto
      .createHash("sha1")
      .update(normalizeProjectPath(projectPath))
      .digest("hex")
      .slice(0, 12);
  }
  return crypto.createHash("sha256").update(identityKey).digest("hex").slice(0, 20);
}

function mapProject(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    primaryPath: row.primary_path,
    identityKey: row.identity_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastOpenedAt: row.last_opened_at,
  };
}

function mapTask(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    sessionId: row.session_id ?? undefined,
    title: row.title,
    goal: row.goal,
    status: row.status,
    checkpoint: row.checkpoint_json
      ? safeJsonParse(row.checkpoint_json) as TaskCheckpoint
      : undefined,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    revision: row.revision,
  };
}

function mapTaskEvent(row: TaskEventRow): TaskEventRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    runId: row.run_id ?? undefined,
    eventType: row.event_type,
    payload: safeJsonParse(row.payload_json),
    createdAt: row.created_at,
  };
}

function isSearchableEventType(eventType: string): boolean {
  return ![
    "agent_text_delta",
    "agent_thinking_delta",
    "agent_tool_progress",
    "agent_stream_signal",
    "agent_status",
    "agent_usage",
  ].includes(eventType);
}

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizeProjectPath(projectPath: string): string {
  const normalized = path.normalize(path.resolve(projectPath)).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function deriveProjectIdentityKey(projectPath: string): string {
  const explicitId = readExplicitProjectId(projectPath);
  if (explicitId) return `allycode:${explicitId}`;

  const gitRemote = readGitRemote(projectPath);
  if (gitRemote) {
    return `git:${crypto.createHash("sha256").update(normalizeGitRemote(gitRemote)).digest("hex")}`;
  }

  return `path:${crypto.createHash("sha256").update(normalizeProjectPath(projectPath)).digest("hex")}`;
}

function readExplicitProjectId(projectPath: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(projectPath, ".allycode", "project.json"), "utf-8");
    const parsed = JSON.parse(raw) as { id?: unknown };
    return typeof parsed.id === "string" && parsed.id.trim() ? parsed.id.trim() : null;
  } catch {
    return null;
  }
}

function readGitRemote(projectPath: string): string | null {
  try {
    let gitDir = path.join(projectPath, ".git");
    const stat = fs.statSync(gitDir);
    if (stat.isFile()) {
      const pointer = fs.readFileSync(gitDir, "utf-8").trim();
      const match = /^gitdir:\s*(.+)$/i.exec(pointer);
      if (!match?.[1]) return null;
      gitDir = path.resolve(projectPath, match[1]);
    }
    const config = fs.readFileSync(path.join(gitDir, "config"), "utf-8");
    const originSection = /\[remote\s+"origin"\]([\s\S]*?)(?=\n\[|$)/i.exec(config)?.[1];
    const url = /^\s*url\s*=\s*(.+)$/im.exec(originSection ?? "")?.[1];
    return url?.trim() || null;
  } catch {
    return null;
  }
}

function normalizeGitRemote(remote: string): string {
  return remote
    .trim()
    .replace(/^https?:\/\/[^/@]+@/i, "https://")
    .replace(/\.git$/i, "")
    .replace(/\\/g, "/")
    .toLowerCase();
}

function safeJsonStringify(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => {
    if (nested instanceof Error) {
      return { name: nested.name, message: nested.message, stack: nested.stack };
    }
    if (typeof nested === "bigint") return nested.toString();
    return nested;
  }) ?? "null";
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function searchableText(value: unknown): string {
  if (typeof value === "string") return value;
  return safeJsonStringify(value);
}
