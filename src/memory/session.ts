import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SESSIONS_DIR } from "../config/settings.js";
import type { ConversationMessage, ModelId, TokenUsage } from "../types/agent.js";
import { logger } from "../utils/logger.js";
import { externalizeContinuation, hydrateContinuation } from "../storage/continuation-state.js";
import { addUsage, emptyUsage, type ModelCallRecord } from "../providers/model-gateway.js";

/**
 * Bump when the on-disk shape changes, and add a step to `migrateSession`.
 * Version 1 is the first explicitly versioned format; files written before it
 * carry no version field and are treated as version 0.
 */
export const CURRENT_SESSION_SCHEMA = 2;

export interface Session {
  /** Absent on files written before versioning; migration fills it in. */
  schemaVersion?: number;
  id: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  model: ModelId;
  /**
   * The canonical transcript. It is append-only: the context budget derives a
   * separate working context for the model and must never shorten this.
   */
  messages: ConversationMessage[];
  totalUsage: TokenUsage;
  title?: string; // Auto-generated from first user message
  compactionState?: import("../agent/context-compaction.js").CompactionState;
  externalEngine?: { id: string; sessionId: string; cwd: string };
  accountedModelCalls?: string[];
}

export interface MigrationOutcome {
  session: Session;
  /** False when the file was already current — nothing needs rewriting. */
  changed: boolean;
  notes: string[];
}

/**
 * Bring a stored session to the current schema.
 *
 * Must be idempotent: migrating an already-migrated session changes nothing
 * and reports `changed: false`, so a crash mid-upgrade cannot corrupt a file
 * on the next attempt. It never drops conversation content — the only thing it
 * removes is provider continuation state, which is transient protocol plumbing
 * that the durable record is not allowed to keep.
 */
export function migrateSession(raw: unknown): MigrationOutcome {
  const notes: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("session 文件不是对象");
  }
  const input = raw as Partial<Session> & Record<string, unknown>;
  if (typeof input.id !== "string" || !Array.isArray(input.messages)) {
    throw new Error("session 缺少 id 或 messages，拒绝迁移");
  }

  const from = typeof input.schemaVersion === "number" ? input.schemaVersion : 0;
  if (from > CURRENT_SESSION_SCHEMA) {
    // A newer AllyCode wrote this. Load it as-is rather than downgrading and
    // silently discarding fields this build does not understand.
    return { session: input as Session, changed: false, notes: ["文件来自更新版本，按原样加载，未做改动"] };
  }

  let changed = false;
  const messages = input.messages as ConversationMessage[];

  if (from < 2) {
    notes.push("schemaVersion=2：续接状态独立私有存储；历史已缺失状态由协议层重新建立上下文。");
    changed = true;
  }

  const session: Session = {
    ...(input as Session),
    schemaVersion: CURRENT_SESSION_SCHEMA,
    messages,
    totalUsage: input.totalUsage ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCost: null, costCurrency: null,
    },
  };
  if (!input.totalUsage) {
    notes.push("补齐缺失的 totalUsage");
    changed = true;
  }
  return { session, changed, notes };
}

export function createSession(cwd: string, model: ModelId): Session {
  const now = new Date().toISOString();
  return {
    schemaVersion: CURRENT_SESSION_SCHEMA,
    id: randomUUID(),
    cwd,
    createdAt: now,
    updatedAt: now,
    model,
    messages: [],
    totalUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCost: null, costCurrency: null,
    },
  };
}

export function assertSessionWorkspace(session: Session, cwd: string): void {
  const normalize = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (normalize(session.cwd) !== normalize(cwd)) throw new Error("会话属于其他项目。请新建任务或打开原项目，不能跨项目续接记忆。");
}

/** Idempotent settlement lets the durable journal repair a crash before JSON save. */
export function accountSessionCall(session: Session, call: ModelCallRecord): void {
  if (call.status === "reserved" || session.accountedModelCalls?.includes(call.id)) return;
  const usage = call.status === "reported" && call.usage ? call.usage : { ...emptyUsage(), unknownCalls: 1, unknownReservedTokens: call.reservedTokens };
  session.totalUsage = addUsage(session.totalUsage, usage);
  (session.accountedModelCalls ??= []).push(call.id);
}

export async function saveSession(session: Session): Promise<void> {
  try {
    await fs.mkdir(SESSIONS_DIR, { recursive: true });
    const filePath = path.join(SESSIONS_DIR, `${session.id}.json`);
    const temporaryPath = `${filePath}.tmp`;
    const updated = { ...session, messages: externalizeContinuation(session.messages), updatedAt: new Date().toISOString() };
    await fs.writeFile(
      temporaryPath,
      JSON.stringify(updated, null, 2),
      { encoding: "utf-8", mode: 0o600 },
    );
    await fs.rename(temporaryPath, filePath);
    if (process.platform !== "win32") await fs.chmod(filePath, 0o600);
    logger.debug("session.saved", { id: session.id });
  } catch (err) {
    logger.error("session.save.error", err);
    throw err;
  }
}

export async function loadSession(id: string): Promise<Session | null> {
  try {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) return null;
    let filePath = path.join(SESSIONS_DIR, `${id}.json`);
    try {
      await fs.access(filePath);
    } catch {
      const files = (await fs.readdir(SESSIONS_DIR))
        .filter((name) => name.endsWith(".json") && name.slice(0, -5).startsWith(id));
      if (files.length !== 1) return null;
      filePath = path.join(SESSIONS_DIR, files[0]!);
    }
    const raw = await fs.readFile(filePath, "utf-8");
    return await loadAndMigrate(filePath, raw);
  } catch {
    return null;
  }
}

/**
 * Parse, migrate, and persist the upgrade — but only after the migrated form
 * is in hand. A failed migration leaves the original file untouched and the
 * session still loads from memory, so an upgrade can never cost a user their
 * history. Nothing here asks the user to delete their data directory.
 */
async function loadAndMigrate(filePath: string, raw: string): Promise<Session | null> {
  let outcome: MigrationOutcome;
  try {
    outcome = migrateSession(JSON.parse(raw) as unknown);
  } catch (err) {
    logger.warn("session.migrate.failed", { filePath, err });
    try {
      return JSON.parse(raw) as Session;
    } catch {
      return null;
    }
  }
  if (outcome.changed) {
    const temporaryPath = `${filePath}.tmp`;
    try {
      const durable = { ...outcome.session, messages: externalizeContinuation(outcome.session.messages) };
      await fs.copyFile(filePath, `${filePath}.pre-v2.bak`, fs.constants.COPYFILE_EXCL).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      await fs.writeFile(temporaryPath, JSON.stringify(durable, null, 2), {
        encoding: "utf-8",
        mode: 0o600,
      });
      await fs.rename(temporaryPath, filePath);
      logger.info("session.migrated", {
        id: outcome.session.id,
        to: CURRENT_SESSION_SCHEMA,
        notes: outcome.notes,
      });
    } catch (err) {
      // The in-memory session is already correct and the original file is
      // untouched, so the same migration simply runs again next time. Remove
      // the half-written temporary file rather than leaving it to accumulate
      // or to be mistaken for a session later.
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      logger.warn("session.migrate.persist_failed", { filePath, err });
    }
  }
  return { ...outcome.session, messages: hydrateContinuation(outcome.session.messages) };
}

export async function listSessions(): Promise<Session[]> {
  try {
    await fs.mkdir(SESSIONS_DIR, { recursive: true });
    const files = await fs.readdir(SESSIONS_DIR);
    const sessions: Session[] = [];

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(SESSIONS_DIR, file), "utf-8");
        // Listing must not rewrite files; migrate in memory only.
        sessions.push(migrateSession(JSON.parse(raw) as unknown).session);
      } catch {
        // Corrupt session file — skip
      }
    }

    // Sort by most recent first
    return sessions.sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  } catch {
    return [];
  }
}

export interface StagedSessionDeletion {
  id: string;
  originalPath: string;
  stagedPath: string;
}

/** Hide files first so the database mutation and visible session list agree. */
export async function stageSessionDeletions(
  ids: string[],
): Promise<StagedSessionDeletion[]> {
  await fs.mkdir(SESSIONS_DIR, { recursive: true });
  const staged: StagedSessionDeletion[] = [];
  try {
    for (const id of [...new Set(ids)]) {
      assertSafeSessionId(id);
      const originalPath = path.join(SESSIONS_DIR, `${id}.json`);
      const stagedPath = path.join(
        SESSIONS_DIR,
        `${id}.${randomUUID()}.deleting`,
      );
      try {
        await fs.rename(originalPath, stagedPath);
        staged.push({ id, originalPath, stagedPath });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") throw error;
      }
    }
    return staged;
  } catch (error) {
    await rollbackSessionDeletions(staged);
    throw error;
  }
}

export async function commitSessionDeletions(
  staged: StagedSessionDeletion[],
): Promise<void> {
  await Promise.all(staged.map(async (item) => {
    await fs.unlink(item.stagedPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }));
}

export async function rollbackSessionDeletions(
  staged: StagedSessionDeletion[],
): Promise<void> {
  await Promise.all(staged.map(async (item) => {
    await fs.rename(item.stagedPath, item.originalPath).catch(() => undefined);
  }));
}

function assertSafeSessionId(id: string): void {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) {
    throw new Error("会话标识无效。");
  }
}

export function deriveTitle(firstUserMessage: string): string {
  return firstUserMessage.slice(0, 60).replace(/\n/g, " ").trim();
}
