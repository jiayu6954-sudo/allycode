import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationMessage } from "../../src/types/agent.js";

/**
 * Integration coverage for the real load path.
 *
 * The unit tests exercise `migrateSession`, which never touches disk. These
 * drive `loadSession` — parse, migrate, write, rename — and inject failures at
 * the write and rename steps, because that is where a botched upgrade would
 * actually cost a user their history.
 */

let root = "";
let sessionsDir = "";

/** Load the module fresh so SESSIONS_DIR picks up the temp data directory. */
async function freshSessionModule() {
  vi.resetModules();
  return import("../../src/memory/session.js");
}

function legacyPayload(id: string): Record<string, unknown> {
  return {
    id,
    cwd: "C:/project",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    model: "deepseek-v4-pro",
    messages: [
      { role: "user", content: "EARLY 开始" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "c1", name: "bash", input: { command: "ls" } }],
        providerState: { protocol: "deepseek-chat", reasoningContent: "SECRET-THINKING" },
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "ok" }] },
      { role: "user", content: "LATE 补充" },
    ] as ConversationMessage[],
    totalUsage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0 },
  };
}

async function writeLegacy(id: string): Promise<string> {
  const filePath = path.join(sessionsDir, `${id}.json`);
  await fs.writeFile(filePath, JSON.stringify(legacyPayload(id), null, 2), "utf8");
  return filePath;
}

async function leftoverTempFiles(): Promise<string[]> {
  return (await fs.readdir(sessionsDir)).filter((name) => name.endsWith(".tmp"));
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "allycode-migrate-"));
  sessionsDir = path.join(root, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  vi.stubEnv("ALLYCODE_DATA_DIR", root);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  await fs.rm(root, { recursive: true, force: true });
});

describe("session migration through the real load path", () => {
  it("upgrades the file on disk and keeps every message", async () => {
    const { loadSession, CURRENT_SESSION_SCHEMA } = await freshSessionModule();
    const filePath = await writeLegacy("upgrade-me");

    const session = await loadSession("upgrade-me");

    expect(session?.schemaVersion).toBe(CURRENT_SESSION_SCHEMA);
    const onDisk = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
    expect(onDisk["schemaVersion"]).toBe(CURRENT_SESSION_SCHEMA);
    expect((onDisk["messages"] as unknown[]).length).toBe(4);
    expect(JSON.stringify(onDisk)).toContain("EARLY 开始");
    expect(JSON.stringify(onDisk)).toContain("LATE 补充");
    expect(JSON.stringify(onDisk)).not.toContain("SECRET-THINKING");
    expect(await leftoverTempFiles()).toEqual([]);
  });

  it("leaves the original file byte-identical when the write fails", async () => {
    const filePath = await writeLegacy("write-fails");
    const before = await fs.readFile(filePath);

    vi.spyOn(fs, "writeFile").mockRejectedValueOnce(new Error("ENOSPC: no space left on device"));
    const { loadSession, CURRENT_SESSION_SCHEMA } = await freshSessionModule();

    const session = await loadSession("write-fails");

    // The user still gets a working, migrated session in memory …
    expect(session).not.toBeNull();
    expect(session?.schemaVersion).toBe(CURRENT_SESSION_SCHEMA);
    expect(session?.messages).toHaveLength(4);
    // … and the file on disk is untouched, down to the byte.
    expect(await fs.readFile(filePath)).toEqual(before);
    expect(await leftoverTempFiles()).toEqual([]);
  });

  it("leaves the original file byte-identical when the rename fails", async () => {
    const filePath = await writeLegacy("rename-fails");
    const before = await fs.readFile(filePath);

    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("EPERM: operation not permitted"));
    const { loadSession } = await freshSessionModule();

    const session = await loadSession("rename-fails");

    expect(session?.messages).toHaveLength(4);
    expect(await fs.readFile(filePath)).toEqual(before);
    // A failed rename leaves a half-written temp file behind unless it is
    // deliberately removed; accumulating them would eventually be mistaken
    // for session data.
    expect(await leftoverTempFiles()).toEqual([]);
  });

  it("retries the migration on the next start after a failed persist", async () => {
    const filePath = await writeLegacy("retry-me");

    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("EPERM"));
    const first = await freshSessionModule();
    await first.loadSession("retry-me");
    const stillLegacy = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
    expect(stillLegacy["schemaVersion"]).toBeUndefined();

    // Next start, no injected failure: the same migration simply runs again.
    vi.restoreAllMocks();
    const second = await freshSessionModule();
    const session = await second.loadSession("retry-me");

    expect(session?.schemaVersion).toBe(second.CURRENT_SESSION_SCHEMA);
    const migrated = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
    expect(migrated["schemaVersion"]).toBe(second.CURRENT_SESSION_SCHEMA);
    expect((migrated["messages"] as unknown[]).length).toBe(4);
    expect(await leftoverTempFiles()).toEqual([]);
  });

  it("does not rewrite a file that is already current", async () => {
    const first = await freshSessionModule();
    const filePath = await writeLegacy("already-current");
    await first.loadSession("already-current");
    const migrated = await fs.readFile(filePath);

    const writeSpy = vi.spyOn(fs, "writeFile");
    const second = await freshSessionModule();
    await second.loadSession("already-current");

    expect(writeSpy).not.toHaveBeenCalled();
    expect(await fs.readFile(filePath)).toEqual(migrated);
  });

  it("listing sessions never rewrites files", async () => {
    await writeLegacy("listed-a");
    await writeLegacy("listed-b");
    const before = await Promise.all([
      fs.readFile(path.join(sessionsDir, "listed-a.json")),
      fs.readFile(path.join(sessionsDir, "listed-b.json")),
    ]);

    const writeSpy = vi.spyOn(fs, "writeFile");
    const { listSessions, CURRENT_SESSION_SCHEMA } = await freshSessionModule();
    const sessions = await listSessions();

    expect(sessions).toHaveLength(2);
    for (const session of sessions) expect(session.schemaVersion).toBe(CURRENT_SESSION_SCHEMA);
    expect(writeSpy).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(sessionsDir, "listed-a.json"))).toEqual(before[0]);
    expect(await fs.readFile(path.join(sessionsDir, "listed-b.json"))).toEqual(before[1]);
  });

  it("still returns a usable session when the file cannot be migrated at all", async () => {
    const filePath = path.join(sessionsDir, "broken.json");
    // Valid JSON, but not a session: migration must refuse rather than invent.
    await fs.writeFile(filePath, JSON.stringify({ nonsense: true }), "utf8");
    const before = await fs.readFile(filePath);

    const { loadSession } = await freshSessionModule();
    const session = await loadSession("broken");

    expect(session).toMatchObject({ nonsense: true });
    expect(await fs.readFile(filePath)).toEqual(before);
    expect(await leftoverTempFiles()).toEqual([]);
  });
});
