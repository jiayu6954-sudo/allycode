import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateCompletionEvidence } from "../../src/observability/completion-gate.js";
import type { TaskEventRecord } from "../../src/storage/agent-database.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function toolEvents(
  id: number,
  toolId: string,
  toolName: string,
  input: Record<string, unknown>,
  isError = false,
): TaskEventRecord[] {
  const base = { taskId: "task", runId: "run", createdAt: new Date(id * 1000).toISOString() };
  return [
    { ...base, id, eventType: "agent_tool_start", payload: { toolId, toolName, input } },
    { ...base, id: id + 1, eventType: "agent_tool_result", payload: { toolId, toolName, isError, content: `[Exit code: ${isError ? 1 : 0}]` } },
  ];
}

async function fixture(packageJson: unknown): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "allycode-completion-gate-"));
  roots.push(root);
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify(packageJson));
  return root;
}

describe("completion evidence gate", () => {
  it("recognizes a standalone project PowerShell suite, while rejecting background/log-only evidence and later mutations",async()=>{
    const cwd=await fixture({});
    await fs.unlink(path.join(cwd,"package.json"));
    await fs.mkdir(path.join(cwd,"tests"));
    await fs.writeFile(path.join(cwd,"tests","run_e2e.ps1"),"exit 0");
    const command='powershell -NoProfile -ExecutionPolicy Bypass -File "tests/run_e2e.ps1"';
    const edit=toolEvents(1,"write","file_edit",{path:"app.sh"});
    const verify=toolEvents(3,"test","bash",{command});
    expect((await evaluateCompletionEvidence(cwd,[...edit,...verify])).status).toBe("passed");
    for (const [name,input] of [["plan_update",{items:[{step:"验证",status:"completed"}]}],["file_read",{path:"report.md"}],["verification_status",{}],["phase_checkpoint",{}]] as const) {
      expect((await evaluateCompletionEvidence(cwd,[...edit,...verify,...toolEvents(5,"after",name,input)])).status).toBe("passed");
    }
    expect((await evaluateCompletionEvidence(cwd,[...edit,...toolEvents(3,"test","bash",{command},true)])).status).toBe("failed");
    expect((await evaluateCompletionEvidence(cwd,[...edit,...verify,...toolEvents(5,"later","file_edit",{path:"app.sh"})])).status).toBe("failed");
    const background=await evaluateCompletionEvidence(cwd,[...edit,...toolEvents(3,"start","service_start",{command}),...toolEvents(5,"log","bash",{command:"Get-Content .allycode/services/e2e.log"})]);
    expect(background.status).toBe("failed");expect(background.checks[0]!.evidence).toContain("后台服务启动");
    for(const bad of [`echo ${command}`,`${command}; echo passed`,`${command} || true`,command.replace("tests/run_e2e.ps1","../tests/run_e2e.ps1"),command.replace("tests/run_e2e.ps1","tests/missing.ps1")]){
      expect((await evaluateCompletionEvidence(cwd,[...edit,...toolEvents(3,"bad","bash",{command:bad})])).status).toBe("failed");
    }
  });
  it("allows design-only document review without exempting source changes or unknown shell",async()=>{
    const cwd=await fixture({});
    const docs=toolEvents(1,"doc","file_write",{path:"ARCHITECTURE.md"});
    expect((await evaluateCompletionEvidence(cwd,docs,{allowDocumentOnly:true})).status).toBe("not_applicable");
    expect((await evaluateCompletionEvidence(cwd,[...docs,...toolEvents(3,"source","file_write",{path:"main.ts"})],{allowDocumentOnly:true})).status).toBe("failed");
    expect((await evaluateCompletionEvidence(cwd,[...docs,...toolEvents(3,"shell","bash",{command:"node change.js"})],{allowDocumentOnly:true})).status).toBe("failed");
  });
  it.each(["echo npm test", "# npm test", "npm test || true", "npm test; echo done", "npm test | cat"])("rejects ambiguous or forged verification: %s", async (command) => {
    const cwd = await fixture({ scripts: { test: "node test.js" } });
    const result = await evaluateCompletionEvidence(cwd, [
      ...toolEvents(1, "write", "file_write", { path: "app.ts" }),
      ...toolEvents(3, "verify", "bash", { command }),
    ]);
    expect(result.status).toBe("failed");
  });

  it("invalidates tests after the last write and after a later failed test", async () => {
    const cwd = await fixture({ scripts: { test: "node test.js" } });
    const write = toolEvents(3, "write", "file_write", { path: "package.json" });
    expect((await evaluateCompletionEvidence(cwd, [...toolEvents(1, "old", "bash", { command: "npm test" }), ...write])).status).toBe("failed");
    expect((await evaluateCompletionEvidence(cwd, [...write, ...toolEvents(5, "ok", "bash", { command: "npm test" }), ...toolEvents(7, "bad", "bash", { command: "npm test" }, true)])).status).toBe("failed");
  });

  it("requires verification after shell-only and external-engine modifications", async () => {
    const cwd = await fixture({ scripts: { test: "node test.js" } });
    for (const [name, input] of [["bash", { command: "node change-source.js" }], ["codex:file_change", { path: "app.ts" }]] as const) {
      expect((await evaluateCompletionEvidence(cwd, toolEvents(1, "mutation", name, input))).status).toBe("failed");
    }
  });
  it("rejects a web/API project whose unit mocks passed but real E2E did not run", async () => {
    const cwd = await fixture({
      scripts: { test: "vitest", build: "vite build" },
      dependencies: { react: "1", fastify: "1" },
      devDependencies: { vitest: "1" },
    });
    const events = [
      ...toolEvents(1, "write", "file_write", { path: "src/app.tsx" }),
      ...toolEvents(3, "test", "bash", { command: "npm test" }),
      ...toolEvents(5, "build", "bash", { command: "npm run build" }),
    ];

    const result = await evaluateCompletionEvidence(cwd, events);

    expect(result.status).toBe("failed");
    expect(result.checks.find((check) => check.id === "browser_e2e")?.status).toBe("failed");
    expect(result.checks.find((check) => check.id === "api_integration")?.status).toBe("failed");
  });

  it("passes only when declared engineering, browser, and API contracts have successful evidence", async () => {
    const cwd = await fixture({
      scripts: {
        verify: "npm run test && npm run typecheck && npm run build && npm run test:e2e && npm run test:integration",
        test: "vitest",
        typecheck: "tsc --noEmit",
        build: "vite build",
        "test:e2e": "playwright test",
        "test:integration": "vitest run test/integration",
      },
      dependencies: { react: "1", fastify: "1" },
      devDependencies: { "@playwright/test": "1", vitest: "1" },
    });
    const events = [
      ...toolEvents(1, "write", "file_edit", { path: "src/app.tsx" }),
      ...toolEvents(3, "verify", "bash", { command: "npm run verify" }),
    ];

    const result = await evaluateCompletionEvidence(cwd, events);

    expect(result.status).toBe("passed");
    expect(result.checks.every((check) => check.status === "passed")).toBe(true);
  });

  it("accepts puppeteer-core with a successfully executed exact E2E script body", async () => {
    const cwd = await fixture({
      scripts: {
        test: "node --test \"test/**/*.test.ts\"",
        "test:e2e": "node scripts/e2e-orchestrator.mjs",
      },
      dependencies: { react: "1" },
      devDependencies: { "puppeteer-core": "1" },
    });
    const events = [
      ...toolEvents(1, "write", "file_edit", { path: "src/app.tsx" }),
      ...toolEvents(3, "test", "bash", { command: "npm test" }),
      ...toolEvents(5, "e2e", "bash", {
        command: "node scripts/e2e-orchestrator.mjs",
      }),
    ];

    const result = await evaluateCompletionEvidence(cwd, events);

    expect(result.status).toBe("passed");
    expect(result.checks.find((check) => check.id === "browser_e2e")?.status).toBe("passed");
  });

  it("does not accept an echoed browser command as execution evidence", async () => {
    const cwd = await fixture({
      scripts: { test: "vitest", "test:e2e": "playwright test" },
      dependencies: { react: "1" },
      devDependencies: { "@playwright/test": "1" },
    });
    const events = [
      ...toolEvents(1, "write", "file_edit", { path: "src/app.tsx" }),
      ...toolEvents(3, "test", "bash", { command: "npm test" }),
      ...toolEvents(5, "fake", "bash", { command: "Write-Output \"playwright test\"" }),
    ];

    const result = await evaluateCompletionEvidence(cwd, events);

    expect(result.status).toBe("failed");
    expect(result.checks.find((check) => check.id === "browser_e2e")?.status).toBe("failed");
  });

  it("does not block read-only tasks", async () => {
    const cwd = await fixture({ scripts: {} });
    await expect(evaluateCompletionEvidence(cwd, [])).resolves.toMatchObject({
      status: "not_applicable",
    });
  });

  it("accepts AllyCode's own browser_verify as real browser evidence", async () => {
    const cwd = await fixture({
      scripts: { test: "vitest", build: "vite build" },
      dependencies: { react: "1" },
      devDependencies: { vitest: "1", vite: "1" },
    });
    const events = [
      ...toolEvents(1, "write", "file_edit", { path: "src/app.tsx" }),
      ...toolEvents(3, "test", "bash", { command: "npm test" }),
      ...toolEvents(5, "build", "bash", { command: "npm run build" }),
      ...toolEvents(7, "verify", "browser_verify", { url: "http://127.0.0.1:4174/" }),
    ];

    const result = await evaluateCompletionEvidence(cwd, events);

    expect(result.status).toBe("passed");
    expect(result.checks.find((check) => check.id === "browser_e2e")?.evidence)
      .toContain("browser_verify");
  });

  it("tells the model what to do when no browser evidence exists at all", async () => {
    const cwd = await fixture({
      scripts: { test: "vitest" },
      dependencies: { react: "1" },
      devDependencies: { vitest: "1" },
    });
    const events = [
      ...toolEvents(1, "write", "file_edit", { path: "src/app.tsx" }),
      ...toolEvents(3, "test", "bash", { command: "npm test" }),
    ];

    const check = (await evaluateCompletionEvidence(cwd, events))
      .checks.find((item) => item.id === "browser_e2e");

    expect(check?.status).toBe("failed");
    expect(check?.evidence).toContain("service_start");
    expect(check?.evidence).toContain("browser_verify");
  });

  it("reports a failed browser_verify as a failure to repair, not as missing evidence", async () => {
    const cwd = await fixture({
      scripts: { test: "vitest" },
      dependencies: { react: "1" },
      devDependencies: { vitest: "1" },
    });
    const events = [
      ...toolEvents(1, "write", "file_edit", { path: "src/app.tsx" }),
      ...toolEvents(3, "test", "bash", { command: "npm test" }),
      ...toolEvents(5, "verify", "browser_verify", { url: "http://127.0.0.1:4174/" }, true),
    ];

    const check = (await evaluateCompletionEvidence(cwd, events))
      .checks.find((item) => item.id === "browser_e2e");

    expect(check?.status).toBe("failed");
    expect(check?.evidence).toContain("已运行但未通过");
  });

  it("does not demand browser E2E from a backend project that merely bundles with vite", async () => {
    const cwd = await fixture({
      scripts: { test: "vitest", build: "vite build" },
      dependencies: { fastify: "1" },
      devDependencies: { vite: "1", vitest: "1" },
    });
    const events = [
      ...toolEvents(1, "write", "file_edit", { path: "src/server.ts" }),
      ...toolEvents(3, "test", "bash", { command: "npm test" }),
      ...toolEvents(5, "build", "bash", { command: "npm run build" }),
    ];

    const result = await evaluateCompletionEvidence(cwd, events);

    expect(result.checks.find((check) => check.id === "browser_e2e")).toBeUndefined();
  });

  it("still demands browser E2E when a bundler ships a real HTML entry point", async () => {
    const cwd = await fixture({
      scripts: { test: "vitest", build: "vite build" },
      dependencies: {},
      devDependencies: { vite: "1", vitest: "1" },
    });
    await fs.writeFile(path.join(cwd, "index.html"), "<!doctype html><div id=app></div>");
    const events = [
      ...toolEvents(1, "write", "file_edit", { path: "src/main.ts" }),
      ...toolEvents(3, "test", "bash", { command: "npm test" }),
      ...toolEvents(5, "build", "bash", { command: "npm run build" }),
    ];

    const result = await evaluateCompletionEvidence(cwd, events);

    expect(result.checks.find((check) => check.id === "browser_e2e")?.status).toBe("failed");
  });

  it("accepts a health-checked service plus a real request when no API script is declared", async () => {
    const cwd = await fixture({
      scripts: { test: "vitest" },
      dependencies: { express: "1" },
      devDependencies: { vitest: "1" },
    });
    const events = [
      ...toolEvents(1, "write", "file_edit", { path: "src/server.ts" }),
      ...toolEvents(3, "test", "bash", { command: "npm test" }),
      ...toolEvents(5, "serve", "service_start", {
        name: "api",
        command: "node src/server.js",
        readyUrl: "http://127.0.0.1:4310/health",
      }),
      ...toolEvents(7, "probe", "bash", {
        command: "curl.exe -s http://127.0.0.1:4310/api/markets",
      }),
    ];

    const check = (await evaluateCompletionEvidence(cwd, events))
      .checks.find((item) => item.id === "api_integration");

    expect(check?.status).toBe("passed");
  });

  it("does not accept a request to an unrelated host as local API evidence", async () => {
    const cwd = await fixture({
      scripts: { test: "vitest" },
      dependencies: { express: "1" },
      devDependencies: { vitest: "1" },
    });
    const events = [
      ...toolEvents(1, "write", "file_edit", { path: "src/server.ts" }),
      ...toolEvents(3, "test", "bash", { command: "npm test" }),
      ...toolEvents(5, "serve", "service_start", {
        name: "api",
        command: "node src/server.js",
        readyUrl: "http://127.0.0.1:4310/health",
      }),
      ...toolEvents(7, "probe", "bash", { command: "curl.exe -s https://example.com/api" }),
    ];

    const check = (await evaluateCompletionEvidence(cwd, events))
      .checks.find((item) => item.id === "api_integration");

    expect(check?.status).toBe("failed");
  });
});
