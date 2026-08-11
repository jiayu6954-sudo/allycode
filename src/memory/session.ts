import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SESSIONS_DIR } from "../config/settings.js";
import type { ConversationMessage, ModelId, TokenUsage } from "../types/agent.js";
import { logger } from "../utils/logger.js";

export interface Session {
  id: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  model: ModelId;
  messages: ConversationMessage[];
  totalUsage: TokenUsage;
  title?: string; // Auto-generated from first user message
}

export function createSession(cwd: string, model: ModelId): Session {
  const now = new Date().toISOString();
  return {
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
      estimatedCostUsd: 0,
    },
  };
}

export async function saveSession(session: Session): Promise<void> {
  try {
    await fs.mkdir(SESSIONS_DIR, { recursive: true });
    const filePath = path.join(SESSIONS_DIR, `${session.id}.json`);
    const temporaryPath = `${filePath}.tmp`;
    const updated = { ...session, updatedAt: new Date().toISOString() };
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
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
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
        sessions.push(JSON.parse(raw) as Session);
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
