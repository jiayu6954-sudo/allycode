import { describe, expect, it } from "vitest";
import {
  buildDeliveryReceipt,
  renderReceipt,
  requiredProofs,
} from "../../src/observability/delivery-receipt.js";
import type { TaskEventRecord } from "../../src/storage/agent-database.js";

let sequence = 1;
const base = { taskId: "task", runId: "run" };

function tool(
  name: string,
  input: Record<string, unknown>,
  isError = false,
  content = "",
): TaskEventRecord[] {
  const toolId = `t${sequence++}`;
  const createdAt = new Date(sequence * 1000).toISOString();
  return [
    { ...base, id: sequence++, eventType: "agent_tool_start", payload: { toolId, toolName: name, input }, createdAt },
    { ...base, id: sequence++, eventType: "agent_tool_result", payload: { toolId, toolName: name, isError, content }, createdAt },
  ] as TaskEventRecord[];
}

function plan(items: Array<[string, "completed" | "in_progress" | "pending"]>): TaskEventRecord {
  return {
    ...base,
    id: sequence++,
    eventType: "agent_plan_update",
    payload: { type: "plan_update", items: items.map(([step, status]) => ({ step, status })) },
    createdAt: new Date(sequence * 1000).toISOString(),
  } as TaskEventRecord;
}

describe("delivery receipt", () => {
  it("does not read a script NAME containing 'test' as testing evidence", () => {
    // The regression: `start:test` is a startup script, not a test suite. Its
    // name once let an unrelated passing unit-test run certify a service that
    // never started.
    expect(requiredProofs("打通 npm run start:test 一次启动 API+Web 并端到端验证"))
      .toEqual(expect.arrayContaining(["service"]));
    expect(requiredProofs("打通 npm run start:test 一次启动 API+Web 并端到端验证"))
      .not.toContain("test");
    expect(requiredProofs("编写单元/集成测试并全部跑通")).toEqual(["test"]);
  });

  it("requires every proof a step implies, not just the first match", () => {
    expect(requiredProofs("真实浏览器端到端验收")).toEqual(
      expect.arrayContaining(["ui", "service"]),
    );
  });

  it("contradicts a completed UI step when no page was ever rendered", () => {
    const events = [
      ...tool("file_write", { path: "src/App.tsx" }),
      ...tool("bash", { command: "npm test" }),
      plan([["实现 React 中文前端五页面", "completed"]]),
    ];

    const receipt = buildDeliveryReceipt(events);

    expect(receipt.outcome).toBe("not_delivered");
    expect(receipt.claims[0]?.verdict).toBe("contradicted");
    expect(receipt.claims[0]?.evidence).toContain("从未在真实浏览器里打开");
  });

  it("verifies a UI step backed by a passing browser_verify", () => {
    const events = [
      ...tool("file_write", { path: "src/App.tsx" }),
      ...tool("service_start", { name: "web", command: "npm run dev", readyUrl: "http://127.0.0.1:4174/" }),
      ...tool("browser_verify", { url: "http://127.0.0.1:4174/", screenshotPath: "evidence/home.png" }),
      plan([["实现前端页面并在浏览器中验证", "completed"]]),
    ];

    const receipt = buildDeliveryReceipt(events);

    expect(receipt.claims[0]?.verdict).toBe("verified");
    expect(receipt.outcome).toBe("delivered");
    expect(receipt.artifacts).toContainEqual({ kind: "screenshot", path: "evidence/home.png" });
  });

  it("counts only a health-checked service as a running service", () => {
    const withoutHealth = buildDeliveryReceipt([
      ...tool("service_start", { name: "api", command: "node server.js" }),
      plan([["启动 API 服务", "completed"]]),
    ]);
    expect(withoutHealth.claims[0]?.verdict).toBe("contradicted");

    const withHealth = buildDeliveryReceipt([
      ...tool("service_start", { name: "api", command: "node server.js", readyUrl: "http://127.0.0.1:4310/health" }),
      plan([["启动 API 服务", "completed"]]),
    ]);
    expect(withHealth.claims[0]?.verdict).toBe("verified");
  });

  it("respects a step that honestly declares its own gap", () => {
    const events = [
      ...tool("file_write", { path: "programs/lib.rs" }),
      plan([["实现 Anchor 合约工程（如实标注未编译）", "completed"]]),
    ];

    const claim = buildDeliveryReceipt(events).claims[0];

    expect(claim?.verdict).toBe("unverifiable");
    expect(claim?.evidence).toContain("声明了没有编译");
  });

  it("never upgrades a claim on the strength of assistant prose", () => {
    const events = [
      { ...base, id: sequence++, eventType: "agent_text_delta", payload: { delta: "全部功能已完成并通过测试！" }, createdAt: new Date().toISOString() } as TaskEventRecord,
      ...tool("file_write", { path: "src/index.ts" }),
      plan([["实现并测试全部功能", "completed"]]),
    ];

    const receipt = buildDeliveryReceipt(events);

    expect(receipt.claims[0]?.verdict).toBe("contradicted");
    expect(receipt.outcome).toBe("not_delivered");
  });

  it("reports timed-out commands as an integrity warning", () => {
    const events = [
      ...tool("bash", { command: "npm run start:test" }, true, "Command timed out after 300000ms. The child-process tree was terminated."),
      ...tool("file_write", { path: "src/server.ts" }),
      plan([["启动服务并验证", "completed"]]),
    ];

    const receipt = buildDeliveryReceipt(events);

    expect(receipt.facts.commandsTimedOut).toBe(1);
    expect(receipt.nextForYou.join(" ")).toContain("卡死");
  });

  it("renders three separate sections a non-engineer can act on", () => {
    const events = [
      ...tool("bash", { command: "npm test" }),
      ...tool("file_write", { path: "docs/RUNNING.md" }),
      ...tool("file_write", { path: "src/app.tsx" }),
      plan([
        ["编写测试并跑通", "completed"],
        ["实现前端页面", "completed"],
        ["搭建工程骨架", "completed"],
      ]),
    ];

    const text = renderReceipt(buildDeliveryReceipt(events), "示例任务");

    expect(text).toContain("✅ 确实做到了");
    expect(text).toContain("❌ 说做完了，但证据不支持");
    expect(text).toContain("❓ 无法核验");
    expect(text).toContain("📋 实际发生过的事");
    expect(text).toContain("👉 接下来需要你决定的");
  });

  it("says so plainly when there is no plan to reconcile", () => {
    const receipt = buildDeliveryReceipt([...tool("file_read", { path: "a.ts" })]);
    expect(receipt.outcome).toBe("nothing_declared");
    expect(receipt.claims).toHaveLength(0);
  });
});
