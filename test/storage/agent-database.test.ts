import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentDatabase } from "../../src/storage/agent-database.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function createFixture(): Promise<{
  root: string;
  database: AgentDatabase;
  firstProject: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "allycode-agent-db-"));
  temporaryRoots.push(root);
  const firstProject = path.join(root, "first-checkout");
  await fs.mkdir(path.join(firstProject, ".git"), { recursive: true });
  await fs.writeFile(
    path.join(firstProject, ".git", "config"),
    '[remote "origin"]\n  url = https://example.com/company/product.git\n',
  );
  return {
    root,
    firstProject,
    database: new AgentDatabase(path.join(root, "state.sqlite")),
  };
}

describe("AgentDatabase", () => {
  it("keeps a stable project identity when a Git project moves", async () => {
    const fixture = await createFixture();
    const first = fixture.database.resolveProject(fixture.firstProject);
    const movedProject = path.join(fixture.root, "moved-checkout");
    await fs.mkdir(path.join(movedProject, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(movedProject, ".git", "config"),
      '[remote "origin"]\n  url = https://example.com/company/product.git\n',
    );

    const moved = fixture.database.resolveProject(movedProject);

    expect(moved.id).toBe(first.id);
    expect(moved.primaryPath).toBe(path.resolve(movedProject));
    fixture.database.close();
  });

  it("persists task checkpoints and a searchable event journal", async () => {
    const fixture = await createFixture();
    const project = fixture.database.resolveProject(fixture.firstProject);
    const task = fixture.database.createTask({
      projectId: project.id,
      title: "修复数据库迁移",
      goal: "Inspect the database migration and repair it",
    });

    fixture.database.updateTaskStatus(task.id, "running", { runId: "run-1" });
    fixture.database.checkpointTask(task.id, {
      reason: "iteration",
      conversationHistory: [{ role: "user", content: "repair the migration" }],
      note: "database inspection completed",
    }, "run-1");
    fixture.database.appendEvent(task.id, "tool_result", {
      toolName: "grep",
      content: "database migration found",
    }, "run-1");

    const stored = fixture.database.getTask(task.id);
    expect(stored?.status).toBe("running");
    expect(stored?.checkpoint?.conversationHistory).toHaveLength(1);
    expect(fixture.database.listEvents(task.id).length).toBeGreaterThanOrEqual(4);
    expect(fixture.database.searchEvents("database").some((event) => event.taskId === task.id))
      .toBe(true);
    fixture.database.close();
  });

  it("reports the complete compact monitor stream while excluding raw deltas", async () => {
    const fixture = await createFixture();
    const project = fixture.database.resolveProject(fixture.firstProject);
    const task = fixture.database.createTask({ projectId: project.id, title: "监控", goal: "验证监控完整性" });
    for (let index = 0; index < 2_100; index++) {
      fixture.database.appendEvent(task.id, "agent_usage", { inputTokens: index });
    }
    fixture.database.appendEvent(task.id, "agent_text_delta", { delta: "private stream chunk" });

    expect(fixture.database.countEvents(task.id)).toBe(2_102);
    expect(fixture.database.listMonitorEvents(task.id)).toHaveLength(2_101);
    expect(fixture.database.listMonitorEvents(task.id).some((item) => item.eventType === "agent_text_delta")).toBe(false);
    fixture.database.close();
  });

  it("turns interrupted active tasks into resumable paused tasks", async () => {
    const fixture = await createFixture();
    const project = fixture.database.resolveProject(fixture.firstProject);
    const task = fixture.database.createTask({
      projectId: project.id,
      title: "长任务",
      goal: "continue after restart",
    });
    fixture.database.updateTaskStatus(task.id, "waiting_permission");

    expect(fixture.database.recoverInterruptedTasks()).toBe(1);
    expect(fixture.database.getTask(task.id)?.status).toBe("paused");
    expect(
      fixture.database.listEvents(task.id).some((event) => event.eventType === "task_recovered"),
    ).toBe(true);
    fixture.database.close();
  });

  it("physically deletes selected durable task data without touching other sessions", async () => {
    const fixture = await createFixture();
    const databasePath = path.join(fixture.root, "state.sqlite");
    const project = fixture.database.resolveProject(fixture.firstProject);
    const selected = fixture.database.createTask({
      projectId: project.id,
      sessionId: "session-delete",
      title: "删除目标",
      goal: "delete this task",
    });
    const preserved = fixture.database.createTask({
      projectId: project.id,
      sessionId: "session-keep",
      title: "保留目标",
      goal: "keep this task",
    });
    fixture.database.appendEvent(selected.id, "tool_result", { content: "unique-delete-token" });
    fixture.database.appendEvent(preserved.id, "tool_result", { content: "unique-keep-token" });
    fixture.database.updateTaskStatus(selected.id, "completed");

    const result = fixture.database.deleteSessionData(["session-delete"], true);

    expect(result.deletedTaskCount).toBe(1);
    expect(result.deletedEventCount).toBeGreaterThan(0);
    expect(fixture.database.getTask(selected.id)).toBeNull();
    expect(fixture.database.getTask(preserved.id)?.sessionId).toBe("session-keep");
    expect(fixture.database.searchEvents("unique-delete-token")).toHaveLength(0);
    expect(fixture.database.searchEvents("unique-keep-token")).toHaveLength(1);
    fixture.database.close();

    const reopened = new AgentDatabase(databasePath);
    expect(reopened.getTask(selected.id)).toBeNull();
    expect(reopened.getTask(preserved.id)).not.toBeNull();
    expect(reopened.searchEvents("unique-delete-token")).toHaveLength(0);
    reopened.close();
  });

  it("can retain a paused durable task while deleting only its session", async () => {
    const fixture = await createFixture();
    const project = fixture.database.resolveProject(fixture.firstProject);
    const task = fixture.database.createTask({
      projectId: project.id,
      sessionId: "session-detach",
      title: "保留检查点",
      goal: "preserve durable task",
    });
    fixture.database.checkpointTask(task.id, {
      reason: "paused",
      conversationHistory: [{ role: "user", content: "continue later" }],
    });
    fixture.database.updateTaskStatus(task.id, "paused");

    const result = fixture.database.deleteSessionData(["session-detach"], false);

    expect(result.detachedTaskCount).toBe(1);
    expect(fixture.database.getTask(task.id)?.sessionId).toBeUndefined();
    expect(fixture.database.getTask(task.id)?.checkpoint?.conversationHistory).toHaveLength(1);
    expect(fixture.database.listEvents(task.id).at(-1)?.eventType).toBe("session_deleted");
    fixture.database.close();
  });

  it("refuses deletion while an associated task is active", async () => {
    const fixture = await createFixture();
    const project = fixture.database.resolveProject(fixture.firstProject);
    const task = fixture.database.createTask({
      projectId: project.id,
      sessionId: "session-active",
      title: "运行中的任务",
      goal: "must pause first",
    });
    fixture.database.updateTaskStatus(task.id, "running");

    expect(() => fixture.database.deleteSessionData(["session-active"], true))
      .toThrow("运行中或等待确认的任务不能删除");
    expect(fixture.database.getTask(task.id)).not.toBeNull();
    fixture.database.close();
  });
});
