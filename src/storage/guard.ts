import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, LOG_FILE, MEMORY_DIR, SESSIONS_DIR } from "../config/settings.js";
import { logger } from "../utils/logger.js";

export const STORAGE_LIMITS = {
  totalBytes: 2 * 1024 ** 3,
  maxSessions: 100,
  logBytes: 10 * 1024 ** 2,
  vectorBytes: 200 * 1024 ** 2,
} as const;

const LOG_TRIM_TARGET = 5 * 1024 ** 2;
const VECTOR_PATH = path.join(MEMORY_DIR, "vectors.json");

interface FileEntry {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface StorageStats {
  dataDir: string;
  totalBytes: number;
  maxBytes: number;
  sessionCount: number;
  maxSessions: number;
  sessionBytes: number;
  logBytes: number;
  maxLogBytes: number;
  vectorBytes: number;
  maxVectorBytes: number;
}

export async function getStorageStats(): Promise<StorageStats> {
  const sessions = await getSessionFiles();
  const [totalBytes, logBytes, vectorBytes] = await Promise.all([
    getDirSize(DATA_DIR),
    getFileSize(LOG_FILE),
    getFileSize(VECTOR_PATH),
  ]);
  return {
    dataDir: DATA_DIR,
    totalBytes,
    maxBytes: STORAGE_LIMITS.totalBytes,
    sessionCount: sessions.length,
    maxSessions: STORAGE_LIMITS.maxSessions,
    sessionBytes: sessions.reduce((sum, item) => sum + item.size, 0),
    logBytes,
    maxLogBytes: STORAGE_LIMITS.logBytes,
    vectorBytes,
    maxVectorBytes: STORAGE_LIMITS.vectorBytes,
  };
}

export async function runStorageGuard(): Promise<void> {
  try {
    await trimSessionsToCount();
    await trimLog();
    await trimVectorStore();
    await trimTotalSize();
  } catch (err) {
    logger.warn("storage_guard.failed", { error: String(err) });
  }
}

async function trimSessionsToCount(): Promise<void> {
  const sessions = (await getSessionFiles()).sort((a, b) => a.mtimeMs - b.mtimeMs);
  const removeCount = Math.max(0, sessions.length - STORAGE_LIMITS.maxSessions);
  for (const file of sessions.slice(0, removeCount)) {
    await fs.unlink(file.path).catch(() => undefined);
  }
  if (removeCount > 0) logger.info("storage_guard.sessions_pruned", { count: removeCount });
}

async function trimLog(): Promise<void> {
  const size = await getFileSize(LOG_FILE);
  if (size <= STORAGE_LIMITS.logBytes) return;
  const handle = await fs.open(LOG_FILE, "r");
  try {
    const offset = Math.max(0, size - LOG_TRIM_TARGET);
    const buffer = Buffer.alloc(size - offset);
    await handle.read(buffer, 0, buffer.length, offset);
    const firstNewline = buffer.indexOf(0x0a);
    await fs.writeFile(
      LOG_FILE,
      firstNewline >= 0 ? buffer.subarray(firstNewline + 1) : buffer,
    );
  } finally {
    await handle.close();
  }
  logger.info("storage_guard.log_trimmed", { beforeBytes: size });
}

async function trimVectorStore(): Promise<void> {
  const size = await getFileSize(VECTOR_PATH);
  if (size <= STORAGE_LIMITS.vectorBytes) return;
  try {
    const raw = JSON.parse(await fs.readFile(VECTOR_PATH, "utf-8")) as {
      chunks?: Array<{ updatedAt?: number }>;
      [key: string]: unknown;
    };
    const chunks = Array.isArray(raw.chunks) ? raw.chunks : [];
    chunks.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    raw.chunks = chunks.slice(0, Math.max(1, Math.floor(chunks.length * 0.7)));
    await fs.writeFile(VECTOR_PATH, JSON.stringify(raw), "utf-8");
    logger.info("storage_guard.vectors_trimmed", {
      beforeBytes: size,
      remainingChunks: raw.chunks.length,
    });
  } catch (err) {
    logger.warn("storage_guard.vector_trim_failed", { error: String(err) });
  }
}

async function trimTotalSize(): Promise<void> {
  let total = await getDirSize(DATA_DIR);
  if (total <= STORAGE_LIMITS.totalBytes) return;
  const target = Math.floor(STORAGE_LIMITS.totalBytes * 0.75);
  const sessions = (await getSessionFiles()).sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const file of sessions) {
    if (total <= target) break;
    await fs.unlink(file.path).catch(() => undefined);
    total -= file.size;
  }
  logger.info("storage_guard.total_trimmed", { remainingBytes: total });
}

async function getDirSize(dir: string): Promise<number> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const sizes = await Promise.all(entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      return entry.isDirectory() ? getDirSize(fullPath) : getFileSize(fullPath);
    }));
    return sizes.reduce((sum, size) => sum + size, 0);
  } catch {
    return 0;
  }
}

async function getFileSize(filePath: string): Promise<number> {
  const stat = await fs.stat(filePath).catch(() => null);
  return stat?.isFile() ? stat.size : 0;
}

async function getSessionFiles(): Promise<FileEntry[]> {
  const files: FileEntry[] = [];
  try {
    const names = await fs.readdir(SESSIONS_DIR);
    await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
      const filePath = path.join(SESSIONS_DIR, name);
      const stat = await fs.stat(filePath).catch(() => null);
      if (stat?.isFile()) {
        files.push({ path: filePath, size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }));
  } catch {
    // Sessions directory may not exist yet.
  }
  return files;
}
