import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DesktopAgentService } from "../../desktop/agent-service.js";
import {
  AGENT_DATABASE_FILE,
  AgentDatabase,
  getAgentDatabase,
} from "../../src/storage/agent-database.js";
import { DATA_DIR, MEMORY_DIR } from "../../src/config/settings.js";
import {
  createSession,
  listSessions,
  loadSession,
  saveSession,
} from "../../src/memory/session.js";

describe("DesktopAgentService session deletion", () => {
  it("deletes selected sessions and durable state while preserving memory and unrelated data", async () => {
    const database = getAgentDatabase();
    const service = new DesktopAgentService(() => null);
    const projectPath = path.join(DATA_DIR, "deletion-project");
    await fs.mkdir(projectPath, { recursive: true });
    const project = database.resolveProject(projectPath);
    const model = "test-model";
    const selectedA = createSession(projectPath, model);
    const selectedB = createSession(projectPath, model);
    const preserved = createSession(projectPath, model);
    selectedA.title = "selected completed";
    selectedB.title = "selected paused";
    preserved.title = "preserved session";
    await Promise.all([saveSession(selectedA), saveSession(selectedB), saveSession(preserved)]);

    const completedTask = database.createTask({
      projectId: project.id,
      sessionId: selectedA.id,
      title: "completed",
      goal: "delete",
    });
    const pausedTask = database.createTask({
      projectId: project.id,
      sessionId: selectedB.id,
      title: "paused",
      goal: "delete",
    });
    const preservedTask = database.createTask({
      projectId: project.id,
      sessionId: preserved.id,
      title: "preserved",
      goal: "keep",
    });
    database.updateTaskStatus(completedTask.id, "completed");
    database.updateTaskStatus(pausedTask.id, "paused");
    database.updateTaskStatus(preservedTask.id, "completed");
    database.appendEvent(completedTask.id, "probe", { content: "desktop-delete-token" });
    database.appendEvent(preservedTask.id, "probe", { content: "desktop-keep-token" });

    await fs.mkdir(MEMORY_DIR, { recursive: true });
    const memorySentinel = path.join(MEMORY_DIR, "must-survive-deletion.txt");
    await fs.writeFile(memorySentinel, "long-term memory survives", "utf-8");

    const result = await service.deleteSessions({
      sessionIds: [selectedA.id, selectedB.id],
      includeDurableTasks: true,
    });

    expect(result.deletedSessionCount).toBe(2);
    expect(result.deletedTaskCount).toBe(2);
    expect(await loadSession(selectedA.id)).toBeNull();
    expect(await loadSession(selectedB.id)).toBeNull();
    expect((await listSessions()).some((session) => session.id === preserved.id)).toBe(true);
    expect(await fs.readFile(memorySentinel, "utf-8")).toBe("long-term memory survives");
    expect(database.getTask(preservedTask.id)).not.toBeNull();
    expect(database.searchEvents("desktop-delete-token")).toHaveLength(0);
    expect(database.searchEvents("desktop-keep-token")).toHaveLength(1);

    // A fresh connection represents the durable view after a desktop restart.
    const afterRestart = new AgentDatabase(AGENT_DATABASE_FILE);
    expect(afterRestart.getTask(completedTask.id)).toBeNull();
    expect(afterRestart.getTask(pausedTask.id)).toBeNull();
    expect(afterRestart.getTask(preservedTask.id)).not.toBeNull();
    expect(afterRestart.searchEvents("desktop-delete-token")).toHaveLength(0);
    afterRestart.close();
  });

  it("rolls the staged session file back when an active task blocks deletion", async () => {
    const database = getAgentDatabase();
    const service = new DesktopAgentService(() => null);
    const projectPath = path.join(DATA_DIR, "active-deletion-project");
    await fs.mkdir(projectPath, { recursive: true });
    const project = database.resolveProject(projectPath);
    const session = createSession(projectPath, "test-model");
    await saveSession(session);
    const task = database.createTask({
      projectId: project.id,
      sessionId: session.id,
      title: "active",
      goal: "must not delete",
    });
    database.updateTaskStatus(task.id, "running");

    await expect(service.deleteSessions({
      sessionIds: [session.id],
      includeDurableTasks: true,
    })).rejects.toThrow("运行中或等待确认的任务不能删除");

    expect(await loadSession(session.id)).not.toBeNull();
    expect(database.getTask(task.id)).not.toBeNull();
  });
});
