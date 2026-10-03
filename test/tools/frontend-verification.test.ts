import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  executeServiceStart,
  executeServiceStatus,
  executeServiceStop,
  stopAllServicesAndWait,
} from "../../src/tools/service.js";
import { executeBrowserVerify, isBrowserAvailable } from "../../src/tools/browser.js";
import { executeWebFetch } from "../../src/tools/web-fetch.js";
import { reserveFreePort } from "../helpers/free-port.js";

/**
 * The frontend dead-end: a long-running server could not survive a tool call,
 * and a JavaScript-rendered page could not be verified. These cover both.
 */

// Ports come from the OS, not from a guess. Test files run in parallel worker
// processes, so a fixed or randomly-based range collides with another file's
// and the child exits with EADDRINUSE — which then reads as a product failure.

/** An SPA shell whose visible content only exists after JavaScript runs. */
function serverSource(port: number): string {
  return `
import http from "node:http";
const routes = { "/": "总览", "/markets": "市场", "/risk": "风险" };
const shell = (route) => \`<!doctype html><html><head><meta charset="utf-8"><title>Loading</title></head>
<body><div id="root"></div><script>
setTimeout(() => {
  document.title = "Binary Market";
  document.getElementById("root").innerHTML =
    "<h1>" + \${JSON.stringify(route)} + "</h1><p>本地 devnet 测试边界</p>";
}, 100);
</script></body></html>\`;
http.createServer((req, res) => {
  const route = routes[req.url];
  if (route === undefined) { res.writeHead(404, { "content-type": "text/html" }); res.end("<html><body>404</body></html>"); return; }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(shell(route));
}).listen(${port}, "127.0.0.1", () => console.log("listening on http://127.0.0.1:${port}/"));
`;
}

/** Windows can hold a directory busy briefly after its last user exits. */
async function removeWhenFree(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

describe("long-running service + real browser verification", () => {
  for (const failSubmission of [false, true]) {
    it.skipIf(!isBrowserAvailable())(`verifies fill/click/assertions and rejects HTTP 500: ${failSubmission}`, async () => {
      const {ctx,base,port}=await makeWorkspace();
      await fs.writeFile(path.join(ctx.cwd,"server.mjs"), `
import http from 'node:http';
http.createServer((req,res)=>{
  if(req.url==='/save'){res.writeHead(${failSubmission ? 500 : 200});res.end('saved');return;}
  res.writeHead(200,{'content-type':'text/html'});
  res.end('<!doctype html><html><body><input id="name"><button id="save">Save</button><div id="result">waiting</div><script>document.querySelector("#save").onclick=async()=>{await fetch("/save",{method:"POST",body:document.querySelector("#name").value});document.querySelector("#result").textContent="saved "+document.querySelector("#name").value;};</script></body></html>');
}).listen(${port},'127.0.0.1');`);
      const started=await executeServiceStart({name:"form",command:"node server.mjs",readyUrl:base},ctx);
      expect(started.isError,started.content).toBe(false);
      const result=await executeBrowserVerify({url:base,actions:[{type:"fill",selector:"#name",value:"Ally"},{type:"click",selector:"#save"},{type:"assertText",selector:"#result",value:"saved Ally"}],settleMs:300},ctx);
      expect(result.isError,result.content).toBe(failSubmission);
      if(failSubmission)expect(result.content).toContain("500");
    },120000);
  }
  let workspace = "";

  afterEach(async () => {
    await stopAllServicesAndWait();
    if (workspace) await removeWhenFree(workspace);
    workspace = "";
  });

  async function makeWorkspace(): Promise<{
    cwd: string;
    ctx: { cwd: string; timeoutMs: number };
    port: number;
    base: string;
  }> {
    const port = await reserveFreePort();
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "allycode-frontend-"));
    await fs.writeFile(path.join(workspace, "server.mjs"), serverSource(port), "utf8");
    return {
      cwd: workspace,
      ctx: { cwd: workspace, timeoutMs: 30_000 },
      port,
      base: `http://127.0.0.1:${port}/`,
    };
  }

  it("keeps a server alive past the tool call and reports it ready", async () => {
    const { ctx, base } = await makeWorkspace();

    const started = await executeServiceStart(
      { name: "web", command: "node server.mjs", readyUrl: base, readyTimeoutMs: 20_000 },
      ctx,
    );
    expect(started.isError, started.content).toBe(false);
    expect(started.content).toContain("RUNNING and READY");

    // The decisive property: the process outlives the tool call that started it.
    const response = await fetch(base, { signal: AbortSignal.timeout(3_000) });
    expect(response.status).toBe(200);

    const status = await executeServiceStatus({}, ctx);
    expect(status.content).toContain("RUNNING");

    // The health URL answers as soon as the socket binds, which can precede the
    // server's own startup log line. Poll rather than assume an ordering the
    // runtime does not guarantee — asserting directly here was flaky.
    let logged = "";
    for (let attempt = 0; attempt < 40; attempt++) {
      logged = (await executeServiceStatus({ name: "web" }, ctx)).content;
      if (logged.includes(base)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(logged, "service_status should surface the URL the process printed").toContain(base);

    const stopped = await executeServiceStop({ all: true }, ctx);
    expect(stopped.isError).toBe(false);
    // service_stop must not return until the port is actually free, otherwise
    // an immediate restart on the same port races a dying process.
    await expect(
      fetch(base, { signal: AbortSignal.timeout(2_000) }),
    ).rejects.toThrow();
  }, 60_000);

  it("refuses to call a service ready when another process owns the port", async () => {
    // The health URL answering proves a listener exists, not that it is ours.
    // Reporting success here would hand the model a service it never started.
    const { ctx, base } = await makeWorkspace();
    const squatter = await executeServiceStart(
      { name: "squatter", command: "node server.mjs", readyUrl: base, readyTimeoutMs: 20_000 },
      ctx,
    );
    expect(squatter.isError, squatter.content).toBe(false);

    const collision = await executeServiceStart(
      { name: "web", command: "node server.mjs", readyUrl: base, readyTimeoutMs: 15_000 },
      ctx,
    );

    expect(collision.isError).toBe(true);
    expect(collision.content).toContain("ANOTHER process");
    expect(collision.content).toMatch(/EADDRINUSE|address already in use/i);
  }, 90_000);

  it("reports the real error when a service fails to start instead of hanging", async () => {
    const { ctx, base } = await makeWorkspace();
    const started = await executeServiceStart(
      { name: "broken", command: "node -e \"console.error('missing config'); process.exit(3)\"", readyUrl: base, readyTimeoutMs: 8_000 },
      ctx,
    );
    expect(started.isError).toBe(true);
    expect(started.content).toContain("exited early");
    expect(started.content).toContain("missing config");
  }, 30_000);

  it("refuses to start the same service twice", async () => {
    const { ctx, base } = await makeWorkspace();
    await executeServiceStart({ name: "web", command: "node server.mjs", readyUrl: base }, ctx);
    const again = await executeServiceStart({ name: "web", command: "node server.mjs", readyUrl: base }, ctx);
    expect(again.content).toContain("ALREADY RUNNING");
  }, 60_000);

  it("frees the port so the same service can be restarted immediately", async () => {
    const { ctx, base } = await makeWorkspace();
    await executeServiceStart(
      { name: "web", command: "node server.mjs", readyUrl: base, readyTimeoutMs: 20_000 },
      ctx,
    );
    await executeServiceStop({ name: "web" }, ctx);
    const restarted = await executeServiceStart(
      { name: "web", command: "node server.mjs", readyUrl: base, readyTimeoutMs: 20_000 },
      ctx,
    );
    expect(restarted.isError, restarted.content).toBe(false);
    expect(restarted.content).toContain("RUNNING and READY");
  }, 90_000);

  it.skipIf(!isBrowserAvailable())(
    "verifies JavaScript-rendered routes that web_fetch cannot see",
    async () => {
      const { ctx, base } = await makeWorkspace();
      const started = await executeServiceStart(
        { name: "web", command: "node server.mjs", readyUrl: base, readyTimeoutMs: 20_000 },
        ctx,
      );
      expect(started.isError, started.content).toBe(false);

      // web_fetch sees the shell only — this is exactly why it proves nothing.
      const fetched = await executeWebFetch({ url: base }, ctx);
      expect(fetched.content).not.toContain("本地 devnet 测试边界");

      const verified = await executeBrowserVerify({
        url: base,
        paths: ["/", "/markets", "/risk"],
        expectText: ["本地 devnet 测试边界"],
        waitForSelector: "#root h1",
        screenshotPath: "evidence/page.png",
        settleMs: 400,
      }, ctx);

      expect(verified.isError, verified.content).toBe(false);
      expect(verified.content).toContain("3/3 pages passed");
      expect(verified.content).toContain("市场");
      expect(verified.metadata?.browserVerified).toBe(true);

      const shots = await fs.readdir(path.join(ctx.cwd, "evidence"));
      expect(shots).toHaveLength(3);
    },
    120_000,
  );

  it.skipIf(!isBrowserAvailable())(
    "fails when the expected content never renders",
    async () => {
      const { ctx, base } = await makeWorkspace();
      await executeServiceStart(
        { name: "web", command: "node server.mjs", readyUrl: base, readyTimeoutMs: 20_000 },
        ctx,
      );
      const verified = await executeBrowserVerify({
        url: `${base}missing-route`,
        expectText: ["总览"],
        timeoutMs: 8_000,
      }, ctx);
      expect(verified.isError).toBe(true);
      expect(verified.content).toContain("FAIL");
      expect(verified.metadata?.browserVerified).toBe(false);
    },
    120_000,
  );

  it.skipIf(!isBrowserAvailable())(
    "surfaces uncaught page exceptions as a failure",
    async () => {
      const { ctx, base } = await makeWorkspace();
      const brokenPort = await reserveFreePort();
      const brokenBase = `http://127.0.0.1:${brokenPort}/`;
      expect(base).not.toBe(brokenBase);
      await fs.writeFile(path.join(ctx.cwd, "broken.mjs"), `
import http from "node:http";
http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end('<!doctype html><html><body><div id="root"></div><script>window.missing.call();</script></body></html>');
}).listen(${brokenPort}, "127.0.0.1", () => console.log("up"));
`, "utf8");
      await executeServiceStart(
        {
          name: "broken-web",
          command: "node broken.mjs",
          readyUrl: brokenBase,
          readyTimeoutMs: 20_000,
        },
        ctx,
      );
      const verified = await executeBrowserVerify({ url: brokenBase }, ctx);
      expect(verified.isError).toBe(true);
      expect(verified.content).toContain("uncaught JavaScript exceptions");
    },
    120_000,
  );
});
