import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  loadLongTermMemory,
  formatMemoryForPrompt,
  hasLongTermMemory,
  clearProjectMemory,
  clearUserMemory,
  memoryRoot,
} from "../../src/memory/long-term.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Use a temp dir as a fake project path — ensures unique fingerprint per test */
async function makeTempProject(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "devai-mem-test-"));
}

/** Write a file directly into the memory store (simulates prior extraction) */
async function seedMemory(
  projectPath: string,
  field: "context" | "decisions" | "learnings",
  content: string
): Promise<void> {
  const root = memoryRoot();
  // Derive fingerprint by matching what the module does
  const crypto = await import("node:crypto");
  const fp = crypto.createHash("sha1")
    .update(path.resolve(projectPath).toLowerCase())
    .digest("hex")
    .slice(0, 12);
  const dir = path.join(root, "projects", fp);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${field}.md`), content, "utf-8");
}

async function seedUserMemory(content: string): Promise<void> {
  const root = memoryRoot();
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "user.md"), content, "utf-8");
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("loadLongTermMemory", () => {
  let projectPath: string;
  let savedUserMemory: string | null = null;

  beforeEach(async () => {
    projectPath = await makeTempProject();
    // Save and clear real user.md so tests get a clean slate
    const root = memoryRoot();
    const userFile = path.join(root, "user.md");
    try {
      savedUserMemory = await fs.readFile(userFile, "utf-8");
      await fs.rm(userFile, { force: true });
    } catch {
      savedUserMemory = null;
    }
  });

  afterEach(async () => {
    await clearProjectMemory(projectPath);
    await fs.rm(projectPath, { recursive: true, force: true });
    // Restore real user.md
    const root = memoryRoot();
    const userFile = path.join(root, "user.md");
    if (savedUserMemory !== null) {
      await fs.writeFile(userFile, savedUserMemory, "utf-8");
    } else {
      await fs.rm(userFile, { force: true });
    }
    savedUserMemory = null;
  });

  it("returns empty strings when no memory exists", async () => {
    const mem = await loadLongTermMemory(projectPath);
    expect(mem.user).toBe("");
    expect(mem.projectContext).toBe("");
    expect(mem.projectDecisions).toBe("");
    expect(mem.projectLearnings).toBe("");
  });

  it("loads seeded project context", async () => {
    await seedMemory(projectPath, "context", "FastAPI + React project");
    const mem = await loadLongTermMemory(projectPath);
    expect(mem.projectContext).toBe("FastAPI + React project");
  });

  it("loads all four memory fields independently", async () => {
    await seedMemory(projectPath, "context", "Django backend");
    await seedMemory(projectPath, "decisions", "Uses JWT for auth");
    await seedMemory(projectPath, "learnings", "env vars go in .env.local");
    const mem = await loadLongTermMemory(projectPath);
    expect(mem.projectContext).toBe("Django backend");
    expect(mem.projectDecisions).toBe("Uses JWT for auth");
    expect(mem.projectLearnings).toBe("env vars go in .env.local");
    expect(mem.user).toBe("");
  });

  it("loads user memory (global, not project-scoped)", async () => {
    await seedUserMemory("Prefers TypeScript strict mode");
    const mem = await loadLongTermMemory(projectPath);
    expect(mem.user).toBe("Prefers TypeScript strict mode");
    // Clean up user memory after this test
    await clearUserMemory();
  });
});

describe("hasLongTermMemory", () => {
  let projectPath: string;
  let savedUserMemory: string | null = null;
  const userMemPath = path.join(memoryRoot(), "user.md");

  beforeEach(async () => {
    projectPath = await makeTempProject();
    // Guard: hasLongTermMemory checks mem.user — real user.md must be hidden
    try { savedUserMemory = await fs.readFile(userMemPath, "utf-8"); await fs.unlink(userMemPath); }
    catch { savedUserMemory = null; }
  });

  afterEach(async () => {
    await clearProjectMemory(projectPath);
    await fs.rm(projectPath, { recursive: true, force: true });
    if (savedUserMemory !== null) await fs.writeFile(userMemPath, savedUserMemory, "utf-8");
    else try { await fs.unlink(userMemPath); } catch { /* ok */ }
    savedUserMemory = null;
  });

  it("returns false when no memory exists", async () => {
    expect(await hasLongTermMemory(projectPath)).toBe(false);
  });

  it("returns true after seeding any field", async () => {
    await seedMemory(projectPath, "learnings", "Don't use global state here");
    expect(await hasLongTermMemory(projectPath)).toBe(true);
  });
});

describe("formatMemoryForPrompt", () => {
  it("returns null when all fields are empty", () => {
    const mem = { user: "", projectContext: "", projectDecisions: "", projectLearnings: "" };
    expect(formatMemoryForPrompt(mem, "/some/project")).toBeNull();
  });

  it("includes project name in header", () => {
    const mem = { user: "", projectContext: "A Node.js app", projectDecisions: "", projectLearnings: "" };
    const result = formatMemoryForPrompt(mem, "/home/user/my-project");
    expect(result).toContain("my-project");
  });

  it("renders user section when present", () => {
    const mem = { user: "Expert in Rust", projectContext: "", projectDecisions: "", projectLearnings: "" };
    const result = formatMemoryForPrompt(mem, "/project");
    expect(result).toContain("About this user");
    expect(result).toContain("Expert in Rust");
  });

  it("renders all four sections when all fields populated", () => {
    const mem = {
      user: "senior dev",
      projectContext: "microservices",
      projectDecisions: "chose gRPC",
      projectLearnings: "watch for port conflicts",
    };
    const result = formatMemoryForPrompt(mem, "/p");
    expect(result).toContain("About this user");
    expect(result).toContain("Project overview");
    expect(result).toContain("Key technical decisions");
    expect(result).toContain("What we've learned");
  });

  it("skips empty sections silently", () => {
    const mem = { user: "", projectContext: "", projectDecisions: "use Zod", projectLearnings: "" };
    const result = formatMemoryForPrompt(mem, "/p") ?? "";
    expect(result).toContain("Key technical decisions");
    expect(result).not.toContain("About this user");
    expect(result).not.toContain("Project overview");
    expect(result).not.toContain("What we've learned");
  });

  it("prompt section contains instructional framing", () => {
    const mem = { user: "Go developer", projectContext: "", projectDecisions: "", projectLearnings: "" };
    const result = formatMemoryForPrompt(mem, "/p") ?? "";
    expect(result).toContain("Long-term memory");
    expect(result).toContain("distilled from previous sessions");
  });
});

describe("clearProjectMemory", () => {
  let projectPath: string;
  let savedUserMemory: string | null = null;
  const userMemPath = path.join(memoryRoot(), "user.md");

  beforeEach(async () => {
    projectPath = await makeTempProject();
    // Guard: clearProjectMemory test checks hasLongTermMemory after clear — user.md must not interfere
    try { savedUserMemory = await fs.readFile(userMemPath, "utf-8"); await fs.unlink(userMemPath); }
    catch { savedUserMemory = null; }
  });

  afterEach(async () => {
    await fs.rm(projectPath, { recursive: true, force: true });
    if (savedUserMemory !== null) await fs.writeFile(userMemPath, savedUserMemory, "utf-8");
    else try { await fs.unlink(userMemPath); } catch { /* ok */ }
    savedUserMemory = null;
  });

  it("removes all project memory files", async () => {
    await seedMemory(projectPath, "context", "some context");
    await seedMemory(projectPath, "learnings", "some learning");
    expect(await hasLongTermMemory(projectPath)).toBe(true);

    await clearProjectMemory(projectPath);
    expect(await hasLongTermMemory(projectPath)).toBe(false);
  });

  it("is idempotent (no error when memory does not exist)", async () => {
    await expect(clearProjectMemory(projectPath)).resolves.not.toThrow();
  });
});
