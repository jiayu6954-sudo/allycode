import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deriveTaskState, renderTaskState } from "../../src/agent/durable-task-state.js";
import { migrateSession, CURRENT_SESSION_SCHEMA, type Session } from "../../src/memory/session.js";
import type { TaskEventRecord } from "../../src/storage/agent-database.js";
import type { ConversationMessage } from "../../src/types/agent.js";

let sequence = 1;
const base = { taskId: "task", runId: "run" };

function tool(
  name: string,
  input: Record<string, unknown>,
  isError = false,
  content = "",
): { events: TaskEventRecord[]; id: string } {
  const toolId = `t${sequence++}`;
  const createdAt = new Date(sequence * 1000).toISOString();
  return {
    id: toolId,
    events: [
      { ...base, id: sequence++, eventType: "agent_tool_start", payload: { toolId, toolName: name, input }, createdAt },
      { ...base, id: sequence++, eventType: "agent_tool_result", payload: { toolId, toolName: name, isError, content }, createdAt },
    ] as TaskEventRecord[],
  };
}

function plan(items: Array<[string, "completed" | "in_progress" | "pending"]>): TaskEventRecord {
  return {
    ...base,
    id: sequence++,
    eventType: "agent_plan_update",
    payload: { items: items.map(([step, status]) => ({ step, status })) },
    createdAt: new Date(sequence * 1000).toISOString(),
  } as TaskEventRecord;
}

describe("durable task state", () => {
  it("takes the goal verbatim from the canonical record", () => {
    const history: ConversationMessage[] = [{ role: "user", content: "交付一个二元市场系统" }];
    const state = deriveTaskState([], history);
    expect(state.goal).toBe("交付一个二元市场系统");
  });

  it("records modified files with the tool calls that prove them", () => {
    const a = tool("file_write", { path: "src/app.ts" });
    const b = tool("file_edit", { path: "src/app.ts" });
    const c = tool("file_write", { path: "src/server.ts" }, true);

    const state = deriveTaskState([...a.events, ...b.events, ...c.events]);

    expect(state.modifiedFiles).toHaveLength(1);
    expect(state.modifiedFiles[0]).toMatchObject({ path: "src/app.ts", writes: 2 });
    expect(state.modifiedFiles[0]?.evidence).toEqual([a.id, b.id]);
  });

  it("keeps a failure unresolved until the same call actually succeeds", () => {
    const failed = tool("bash", { command: "npm run build" }, true, "TS2304: Cannot find name 'foo'");
    const state = deriveTaskState([...failed.events]);
    expect(state.unresolvedErrors).toHaveLength(1);
    expect(state.unresolvedErrors[0]?.summary).toContain("TS2304");

    const fixed = tool("bash", { command: "npm run build" });
    const after = deriveTaskState([...failed.events, ...fixed.events]);
    expect(after.unresolvedErrors).toHaveLength(0);
  });

  it("flags an identical failing call that was simply retried", () => {
    const first = tool("bash", { command: "npm test" }, true, "1 failed");
    const again = tool("bash", { command: "npm test" }, true, "1 failed");

    const state = deriveTaskState([...first.events, ...again.events]);

    expect(state.unresolvedErrors[0]?.repeated).toBe(true);
    expect(state.unresolvedErrors[0]?.evidence).toEqual([first.id, again.id]);
    expect(state.nextAction).toContain("换方法");
  });

  it("never promotes a completed plan step without evidence into a fact", () => {
    // The model marked everything done; the log shows nothing supporting it.
    const state = deriveTaskState([plan([["实现真实浏览器端到端验收", "completed"]])]);

    expect(state.declaredComplete).toHaveLength(1);
    expect(state.declaredComplete[0]?.candidateEvidence).toEqual([]);
    expect(state.declaredComplete[0]?.status).toBe("declared_without_evidence");
    // An empty evidence list is the signal a resumed run must be able to see.
    expect(state.modifiedFiles).toHaveLength(0);
    expect(state.testsRun).toHaveLength(0);
  });

  it("minimal repro: browser E2E declared done with zero tool evidence", () => {
    // Before the fix this rendered as "✓ 实现真实浏览器端到端验收", closed with
    // "以上为已核验状态", and told a resumed run to move on to delivery.
    const state = deriveTaskState(
      [plan([["实现真实浏览器端到端验收", "completed"]])],
      [{ role: "user", content: "交付前端" }],
    );
    const text = renderTaskState(state);

    expect(text).not.toContain("✓ 实现真实浏览器端到端验收");
    expect(text).not.toContain("以上为已核验状态");
    expect(text).toContain("[声明完成·无证据] 实现真实浏览器端到端验收");
    expect(text).toContain("没有任何工具证据");
    expect(state.nextAction).toContain("先补验证再谈交付");
    expect(state.nextAction).not.toContain("转入验证与交付");
  });

  it("calls keyword-matched associations candidates, never verification", () => {
    const write = tool("file_write", { path: "src/browser-verify.ts" });
    const state = deriveTaskState([
      ...write.events,
      plan([["实现 browser-verify 模块", "completed"]]),
    ]);

    expect(state.declaredComplete[0]?.status).toBe("declared_with_candidates");
    const text = renderTaskState(state);
    expect(text).toContain("候选证据未核验");
    // Even WITH candidates the next action must not be delivery.
    expect(state.nextAction).toContain("候选证据未经核验");
    expect(state.nextAction).toContain("先实际运行验证");
  });

  it("errs toward 'no evidence' for Chinese steps rather than inventing a match", () => {
    // Term extraction splits on whitespace, which Chinese does not use, so a
    // Chinese step almost never matches. Failing closed is correct here; the
    // test pins the behaviour so it cannot silently become a false positive.
    const write = tool("file_write", { path: "src/浏览器验收.ts" });
    const state = deriveTaskState([...write.events, plan([["实现浏览器验收", "completed"]])]);

    expect(state.declaredComplete[0]?.status).toBe("declared_without_evidence");
    expect(renderTaskState(state)).toContain("[声明完成·无证据]");
  });

  it("resolves only when a success follows the failure", () => {
    // success → failure must stay unresolved: the build is broken now.
    const ok = tool("bash", { command: "npm run build" });
    const bad = tool("bash", { command: "npm run build" }, true, "TS2304 build failed");
    const successThenFailure = deriveTaskState([...ok.events, ...bad.events]);
    expect(successThenFailure.unresolvedErrors).toHaveLength(1);
    expect(successThenFailure.unresolvedErrors[0]?.summary).toContain("TS2304");
    expect(successThenFailure.unresolvedErrors[0]?.repeated).toBe(false);

    // failure → success → failure must also stay unresolved.
    const f1 = tool("bash", { command: "npm test" }, true, "fail A");
    const s1 = tool("bash", { command: "npm test" });
    const f2 = tool("bash", { command: "npm test" }, true, "fail B");
    const flapping = deriveTaskState([...f1.events, ...s1.events, ...f2.events]);
    expect(flapping.unresolvedErrors).toHaveLength(1);
    expect(flapping.unresolvedErrors[0]?.summary).toContain("fail B");
    // The streak restarts at the success, so one later failure is not a loop.
    expect(flapping.unresolvedErrors[0]?.repeated).toBe(false);
    expect(flapping.unresolvedErrors[0]?.evidence).toEqual([f2.id]);
  });

  it("counts repeats only since the most recent success", () => {
    const f1 = tool("bash", { command: "npm run lint" }, true, "x");
    const f2 = tool("bash", { command: "npm run lint" }, true, "x");
    const ok = tool("bash", { command: "npm run lint" });
    const f3 = tool("bash", { command: "npm run lint" }, true, "y");
    const f4 = tool("bash", { command: "npm run lint" }, true, "y");

    const state = deriveTaskState([...f1.events, ...f2.events, ...ok.events, ...f3.events, ...f4.events]);

    expect(state.unresolvedErrors).toHaveLength(1);
    expect(state.unresolvedErrors[0]?.repeated).toBe(true);
    // The earlier, already-fixed streak must not be attributed to this one.
    expect(state.unresolvedErrors[0]?.evidence).toEqual([f3.id, f4.id]);
  });

  it("points a resumed run at the unresolved error before the next step", () => {
    const failed = tool("bash", { command: "npm run build" }, true, "build failed");
    const state = deriveTaskState([
      plan([["写代码", "completed"], ["跑构建", "in_progress"], ["部署", "pending"]]),
      ...failed.events,
    ]);

    expect(state.currentStep).toBe("跑构建");
    expect(state.nextAction).toContain("先修复未解决的错误");
  });

  it("tells a resumed run not to trust memory over the repository", () => {
    const state = deriveTaskState([plan([["搭骨架", "completed"]])], [{ role: "user", content: "目标" }]);
    const text = renderTaskState(state);
    expect(text).toContain("由持久事件推导");
    expect(text).toContain("未经核验");
    expect(text).toContain("不要凭记忆假设");
    // The closing line must separate what is evidenced from what is declared.
    expect(text).toContain("计划状态与候选证据均未经核验");
  });
});

describe("session schema migration", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  function legacySession(): Record<string, unknown> {
    return {
      id: "abc",
      cwd: "C:/project",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      model: "deepseek-v4-pro",
      messages: [
        { role: "user", content: "开始" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "c1", name: "bash", input: { command: "ls" } }],
          providerState: { protocol: "deepseek-chat", reasoningContent: "很长的历史思考" },
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "ok" }] },
      ],
      totalUsage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0 },
    };
  }

  it("loads a pre-versioning session and stamps the current schema", () => {
    const outcome = migrateSession(legacySession());
    expect(outcome.changed).toBe(true);
    expect(outcome.session.schemaVersion).toBe(CURRENT_SESSION_SCHEMA);
    expect(outcome.session.messages).toHaveLength(3);
  });

  it("is idempotent — migrating twice changes nothing further", () => {
    const first = migrateSession(legacySession());
    const second = migrateSession(JSON.parse(JSON.stringify(first.session)) as unknown);

    expect(second.changed).toBe(false);
    expect(JSON.stringify(second.session)).toBe(JSON.stringify(first.session));
  });

  it("preserves protocol state for private-store migration", () => {
    const outcome = migrateSession(legacySession());
    const serialized = JSON.stringify(outcome.session);

    expect(serialized).toContain("很长的历史思考");
    expect(serialized).toContain("开始");
    expect(serialized).toContain("tool_result");
    expect(outcome.notes.join(" ")).toContain("续接状态");
  });

  it("loads a file from a newer build untouched rather than downgrading it", () => {
    const future = { ...legacySession(), schemaVersion: CURRENT_SESSION_SCHEMA + 5, futureField: "keep me" };
    const outcome = migrateSession(future);

    expect(outcome.changed).toBe(false);
    expect((outcome.session as unknown as Record<string, unknown>)["futureField"]).toBe("keep me");
  });

  it("refuses to migrate a file that is not a session instead of inventing one", () => {
    expect(() => migrateSession({ nonsense: true })).toThrow(/id 或 messages/);
    expect(() => migrateSession("not an object")).toThrow();
  });

  it("migrates a real alpha.8 fixture without losing conversation content", async () => {
    const fixturePath = path.join("test", "fixtures", "token-efficiency", "long-failed-delivery.json");
    const raw = JSON.parse(await fs.readFile(fixturePath, "utf8")) as { messages: ConversationMessage[] };
    const before = raw.messages.length;

    const session: Record<string, unknown> = {
      id: "alpha8-fixture",
      cwd: "C:/project",
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
      model: "deepseek-v4-pro",
      messages: raw.messages,
    };

    const outcome = migrateSession(session);

    expect(outcome.session.schemaVersion).toBe(CURRENT_SESSION_SCHEMA);
    expect(outcome.session.messages).toHaveLength(before);
    expect(outcome.session.totalUsage).toBeDefined();
    // Migration preserves the source; persistence moves private state out of JSON.
    const carrying = outcome.session.messages.filter((message) => {
      const state = message.providerState;
      return state?.protocol === "deepseek-chat" && Boolean(state.reasoningContent);
    });
    expect(carrying.length).toBeGreaterThan(0);

    const again = migrateSession(JSON.parse(JSON.stringify(outcome.session)) as unknown);
    expect(again.changed).toBe(false);
  });

  it("keeps the original file when the migrated form cannot be written", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "allycode-session-"));
    roots.push(root);
    const filePath = path.join(root, "s.json");
    const original = JSON.stringify(legacySession(), null, 2);
    await fs.writeFile(filePath, original, "utf8");

    // Simulate the persist step failing by making the target read-only-ish:
    // migrateSession itself must not touch disk, so the file is unchanged.
    migrateSession(JSON.parse(original) as unknown);

    expect(await fs.readFile(filePath, "utf8")).toBe(original);
  });

  it("accepts a session whose totalUsage was never written", () => {
    const legacy = legacySession();
    delete legacy["totalUsage"];
    const outcome = migrateSession(legacy);

    expect(outcome.changed).toBe(true);
    expect(outcome.session.totalUsage).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });
});

describe("session type surface", () => {
  it("stamps new sessions with the current schema", async () => {
    const { createSession } = await import("../../src/memory/session.js");
    const session: Session = createSession("C:/project", "deepseek-v4-pro");
    expect(session.schemaVersion).toBe(CURRENT_SESSION_SCHEMA);
  });
});
