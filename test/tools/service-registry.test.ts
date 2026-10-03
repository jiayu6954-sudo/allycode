import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ToolRegistry } from "../../src/tools/registry.js";
import { stopAllServicesAndWait } from "../../src/tools/service.js";
import { classifyRisk } from "../../src/permissions/classifier.js";
import { reserveFreePort } from "../helpers/free-port.js";

/**
 * The registry is the path the model actually takes. A tool that works when
 * called directly but is unreachable through the registry is still a dead end.
 */

// Assigned per test from a port the OS confirms is free, so this file cannot
// collide with another test file running in a parallel worker.
let PORT = 0;
let BASE = "";

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

describe("service and browser tools through the tool registry", () => {
  let workspace = "";

  beforeEach(async () => {
    PORT = await reserveFreePort();
    BASE = `http://127.0.0.1:${PORT}/`;
  });

  afterEach(async () => {
    await stopAllServicesAndWait();
    if (workspace) await removeWhenFree(workspace);
    workspace = "";
  });

  it("exposes the service and browser tools to the model", () => {
    const names = new ToolRegistry(process.cwd()).getDefinitions().map((def) => def.name);
    expect(names).toContain("service_start");
    expect(names).toContain("service_status");
    expect(names).toContain("service_stop");
    expect(names).toContain("browser_verify");
  });

  it("warns the model away from running servers in the shell tool", () => {
    const bash = new ToolRegistry(process.cwd()).getDefinitions()
      .find((def) => def.name === "bash");
    expect(bash?.description).toContain("service_start");
    expect(bash?.description).toMatch(/never use this for a process that does not exit/i);
  });

  it("auto-approves verifying a locally served page but not an external site", () => {
    expect(classifyRisk("browser_verify", { url: BASE })).toBe("safe");
    expect(classifyRisk("browser_verify", { url: "https://example.com/" })).toBe("moderate");
    expect(classifyRisk("service_stop", { all: true })).toBe("safe");
    expect(classifyRisk("service_start", { name: "x", command: "npm run dev" })).toBe("moderate");
    expect(classifyRisk("service_start", { name: "x", command: "rm -rf /" })).toBe("dangerous");
  });

  it("starts, inspects and stops a service through registry.execute", async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "allycode-registry-"));
    await fs.writeFile(path.join(workspace, "server.mjs"), `
import http from "node:http";
http.createServer((_req, res) => { res.writeHead(200); res.end("ok"); })
  .listen(${PORT}, "127.0.0.1", () => console.log("listening on ${BASE}"));
`, "utf8");
    const registry = new ToolRegistry(workspace);

    const started = await registry.execute("service_start", {
      name: "api",
      command: "node server.mjs",
      readyUrl: BASE,
      readyTimeoutMs: 20_000,
    });
    expect(started.isError, started.content).toBe(false);
    expect(started.fromCache).toBe(false);

    // Two identical calls must never be served from cache — state has moved on.
    const status = await registry.execute("service_status", {});
    expect(status.fromCache).toBe(false);
    expect(status.content).toContain("RUNNING");

    const stopped = await registry.execute("service_stop", { all: true });
    expect(stopped.isError).toBe(false);
  }, 60_000);

  it("rejects malformed tool input with a usable message", async () => {
    const registry = new ToolRegistry(process.cwd());
    const result = await registry.execute("service_start", { name: "api" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid tool input");
  });
});
