import { hydrateContinuation } from "../../src/storage/continuation-state.js";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixtureRoot = path.join(process.cwd(), ".test-tmp-provider-state");

describe("provider turn state persistence", () => {
  beforeEach(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
    vi.resetModules();
    vi.stubEnv("ALLYCODE_DATA_DIR", fixtureRoot);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it("survives canonical session JSON save and reload", async () => {
    const { createSession, loadSession, saveSession } = await import("../../src/memory/session.js");
    const session = createSession("D:\\project", "deepseek-v4-pro");
    session.messages.push({
      role: "assistant",
      providerState: {
        protocol: "deepseek-chat",
        reasoningContent: "opaque reasoning continuation",
      },
      content: [{
        type: "tool_use",
        id: "call_1",
        name: "file_read",
        input: { path: "README.md" },
      }],
    });

    await saveSession(session);
    const loaded = await loadSession(session.id);
    expect(await fs.readFile(path.join(fixtureRoot, "sessions", `${session.id}.json`), "utf8")).not.toContain("opaque reasoning continuation");

    expect(loaded?.messages[0]).toMatchObject({
      providerState: {
        protocol: "deepseek-chat",
        reasoningContent: "opaque reasoning continuation",
      },
    });
  });

  it("survives SQLite checkpoint serialization and reload", async () => {
    const { AgentDatabase } = await import("../../src/storage/agent-database.js");
    const database = new AgentDatabase(path.join(fixtureRoot, "agent.db"));
    try {
      const projectRoot = path.join(fixtureRoot, "project");
      await fs.mkdir(projectRoot, { recursive: true });
      const project = database.resolveProject(projectRoot);
      const task = database.createTask({
        projectId: project.id,
        title: "provider state",
        goal: "verify state",
      });
      database.checkpointTask(task.id, {
        reason: "iteration",
        conversationHistory: [{
          role: "assistant",
          providerState: {
            protocol: "responses",
            responseId: "resp_1",
            outputItems: [{ type: "reasoning", encrypted_content: "opaque" }],
          },
          content: [{
            type: "tool_use",
            id: "call_1",
            name: "file_read",
            input: { path: "README.md" },
          }],
        }],
      });

      const history = database.getTask(task.id)!.checkpoint!.conversationHistory;
      expect(JSON.stringify(history)).not.toContain("encrypted_content");
      expect(hydrateContinuation(history, path.join(fixtureRoot, "private-continuation"))[0]).toMatchObject({
        providerState: {
          protocol: "responses",
          responseId: "resp_1",
          outputItems: [{ type: "reasoning", encrypted_content: "opaque" }],
        },
      });
    } finally {
      database.close();
    }
  });
});
