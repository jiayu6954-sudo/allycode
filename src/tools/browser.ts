import fs from "node:fs";
import os from "node:os";
import { DATA_DIR } from "../config/settings.js";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type {
  BrowserVerifyInput,
  ToolExecutionContext,
  ToolResult,
} from "../types/tools.js";
import { resolveWorkspacePath } from "./path-guard.js";
import { logger } from "../utils/logger.js";

/**
 * Real-browser page verification over the Chrome DevTools Protocol.
 *
 * web_fetch only ever sees the initial HTML, so a React/Vue app looks like an
 * empty shell and no frontend work could be verified. This drives an installed
 * Chrome or Edge in headless mode through CDP — real layout, real JavaScript,
 * real console errors — with no npm dependency and no browser download.
 */

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_TEXT_CHARS = 4_000;
const MAX_PATHS = 12;

interface PageReport {
  url: string;
  ok: boolean;
  httpStatus?: number;
  title?: string;
  textLength: number;
  textSample: string;
  consoleErrors: string[];
  pageExceptions: string[];
  failedRequests: string[];
  missingText: string[];
  selectorFound?: boolean;
  screenshotPath?: string;
  failure?: string;
}

// ── CDP transport ────────────────────────────────────────────────────────────

type CdpEventHandler = (method: string, params: Record<string, unknown>, sessionId?: string) => void;

class CdpConnection {
  private socket: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  private handlers: CdpEventHandler[] = [];
  private closed = false;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event: MessageEvent) => {
      const raw = typeof event.data === "string" ? event.data : String(event.data);
      let payload: Record<string, unknown>;
      try { payload = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
      const id = typeof payload["id"] === "number" ? payload["id"] : undefined;
      if (id !== undefined) {
        const waiter = this.pending.get(id);
        if (!waiter) return;
        this.pending.delete(id);
        const error = payload["error"] as { message?: string } | undefined;
        if (error) waiter.reject(new Error(error.message ?? "CDP error"));
        else waiter.resolve((payload["result"] as Record<string, unknown>) ?? {});
        return;
      }
      const method = payload["method"];
      if (typeof method === "string") {
        const params = (payload["params"] as Record<string, unknown>) ?? {};
        const sessionId = typeof payload["sessionId"] === "string" ? payload["sessionId"] : undefined;
        for (const handler of this.handlers) handler(method, params, sessionId);
      }
    });
    socket.addEventListener("close", () => {
      this.closed = true;
      for (const waiter of this.pending.values()) waiter.reject(new Error("CDP connection closed"));
      this.pending.clear();
    });
  }

  static connect(url: string, timeoutMs: number): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        try { socket.close(); } catch { /* ignore */ }
        reject(new Error(`CDP handshake timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(new CdpConnection(socket));
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("CDP socket error"));
      }, { once: true });
    });
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 15_000,
  ): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error("CDP connection closed"));
    const id = this.nextId++;
    const message: Record<string, unknown> = { id, method, params };
    if (sessionId) message["sessionId"] = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      try {
        this.socket.send(JSON.stringify(message));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  on(handler: CdpEventHandler): void {
    this.handlers.push(handler);
  }

  close(): void {
    this.closed = true;
    try { this.socket.close(); } catch { /* ignore */ }
  }
}

// ── Browser discovery ────────────────────────────────────────────────────────

function candidateBrowsers(): string[] {
  const fromEnv = [
    process.env["ALLYCODE_BROWSER"],
    process.env["PUPPETEER_EXECUTABLE_PATH"],
    process.env["CHROME_PATH"],
  ].filter((value): value is string => Boolean(value));

  if (process.platform === "win32") {
    const roots = [
      process.env["PROGRAMFILES"],
      process.env["PROGRAMFILES(X86)"],
      process.env["LOCALAPPDATA"],
    ].filter((value): value is string => Boolean(value));
    const relatives = [
      "Google\\Chrome\\Application\\chrome.exe",
      "Microsoft\\Edge\\Application\\msedge.exe",
      "Chromium\\Application\\chrome.exe",
      "BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    ];
    return [
      ...fromEnv,
      ...roots.flatMap((root) => relatives.map((relative) => path.join(root, relative))),
    ];
  }
  if (process.platform === "darwin") {
    return [
      ...fromEnv,
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  }
  const found = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"]
    .map((name) => {
      const probe = spawnSync("which", [name], { encoding: "utf8" });
      return probe.status === 0 ? probe.stdout.trim() : "";
    })
    .filter(Boolean);
  const managed = path.join(DATA_DIR,"components/browser");
  const installed: string[] = [];
  try { for(const entry of fs.readdirSync(managed)) if(/^chromium-\d+$/.test(entry))
    for(const layout of ["chrome-linux/chrome","chrome-linux64/chrome"]) installed.push(path.join(managed,entry,layout));
  } catch { /* component not installed */ }
  return [...fromEnv, ...found, ...installed];
}

function findBrowser(): string | null {
  for (const candidate of candidateBrowsers()) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch { /* keep looking */ }
  }
  return null;
}

/** Whether real-browser verification is possible on this machine. */
export function isBrowserAvailable(): boolean {
  return findBrowser() !== null;
}

async function readDevToolsPort(userDataDir: string, deadline: number, child: ChildProcess): Promise<number> {
  const portFile = path.join(userDataDir, "DevToolsActivePort");
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`the browser process exited with code ${child.exitCode ?? child.signalCode} before opening a debug port`);
    }
    try {
      const raw = fs.readFileSync(portFile, "utf8");
      const port = Number.parseInt(raw.split("\n")[0] ?? "", 10);
      if (Number.isInteger(port) && port > 0) return port;
    } catch { /* not written yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("the browser never reported a DevTools debug port");
}

// ── Verification ─────────────────────────────────────────────────────────────

export async function executeBrowserVerify(
  input: BrowserVerifyInput,
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  if (input.actions?.some((action) => action.type === "assertText" && !action.value?.trim())) return { content: "assertText 必须提供非空的预期内容。", isError: true };
  const executable = findBrowser();
  if (!executable) {
    return {
      content: [
        "No Chrome, Edge, Chromium or Brave installation was found, so real-browser verification is unavailable.",
        "Install one, or set ALLYCODE_BROWSER to the browser executable path.",
        "Do not claim the UI works without this evidence — report the gap instead.",
      ].join("\n"),
      isError: true,
    };
  }

  const timeoutMs = Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const targets = buildTargets(input);
  if (targets.length === 0) {
    return { content: "browser_verify needs a valid absolute http(s) url.", isError: true };
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "allycode-cdp-"));
  let child: ChildProcess | null = null;
  let connection: CdpConnection | null = null;

  try {
    child = spawn(executable, [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-features=Translate,MediaRouter,OptimizationHints",
      "--hide-scrollbars",
      "--mute-audio",
      "about:blank",
    ], { windowsHide: true, stdio: "ignore" });

    const port = await readDevToolsPort(userDataDir, Date.now() + 30_000, child);
    const version = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(5_000),
    }).then((response) => response.json() as Promise<{ webSocketDebuggerUrl?: string }>);
    if (!version.webSocketDebuggerUrl) throw new Error("the browser did not expose a WebSocket debugger URL");

    connection = await CdpConnection.connect(version.webSocketDebuggerUrl, 10_000);

    const reports: PageReport[] = [];
    for (const [index, target] of targets.entries()) {
      reports.push(await verifyOnePage(connection, target, input, ctx, timeoutMs, index, targets.length));
      if (ctx.signal?.aborted) break;
    }
    return renderReport(reports, executable, input);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("browser.verify_failed", err);
    return {
      content: [
        `Real-browser verification could not run: ${msg}`,
        `Browser: ${executable}`,
        "This is a verification-environment failure, not proof that the page works.",
      ].join("\n"),
      isError: true,
    };
  } finally {
    connection?.close();
    await shutdownBrowser(child, userDataDir);
  }
}

/**
 * The browser holds its profile open until the process is really gone, so
 * removing the directory straight after taskkill silently fails and leaks a
 * multi-megabyte profile per verification. Wait for exit, then retry the
 * removal briefly.
 */
async function shutdownBrowser(child: ChildProcess | null, userDataDir: string): Promise<void> {
  const pid = child?.pid;
  if (pid) {
    if (process.platform === "win32") {
      spawnSync("taskkill.exe", ["/pid", String(pid), "/t", "/f"], { windowsHide: true, timeout: 5_000 });
    } else {
      try { child?.kill("SIGKILL"); } catch { /* already gone */ }
    }
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); } catch { break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  logger.warn("browser.profile_cleanup_failed", { userDataDir });
}

/** Sweep profiles left behind by an earlier crash or a hard process kill. */
export function reclaimStaleBrowserProfiles(maxAgeMs = 60 * 60 * 1000): number {
  let removed = 0;
  const root = os.tmpdir();
  let entries: string[];
  try { entries = fs.readdirSync(root); } catch { return 0; }
  for (const entry of entries) {
    if (!entry.startsWith("allycode-cdp-")) continue;
    const target = path.join(root, entry);
    try {
      if (Date.now() - fs.statSync(target).mtimeMs < maxAgeMs) continue;
      fs.rmSync(target, { recursive: true, force: true });
      removed++;
    } catch { /* still locked or already gone */ }
  }
  return removed;
}

function buildTargets(input: BrowserVerifyInput): string[] {
  let base: URL;
  try {
    base = new URL(input.url);
  } catch {
    return [];
  }
  if (!/^https?:$/.test(base.protocol)) return [];
  if (!input.paths || input.paths.length === 0) return [base.toString()];
  const targets: string[] = [];
  for (const entry of input.paths.slice(0, MAX_PATHS)) {
    try {
      targets.push(new URL(entry, base).toString());
    } catch { /* skip malformed path */ }
  }
  return targets.length > 0 ? targets : [base.toString()];
}

async function verifyOnePage(
  connection: CdpConnection,
  url: string,
  input: BrowserVerifyInput,
  ctx: ToolExecutionContext,
  timeoutMs: number,
  index: number,
  total: number,
): Promise<PageReport> {
  const report: PageReport = {
    url,
    ok: false,
    textLength: 0,
    textSample: "",
    consoleErrors: [],
    pageExceptions: [],
    failedRequests: [],
    missingText: [],
  };

  const created = await connection.send("Target.createTarget", { url: "about:blank" });
  const targetId = created["targetId"] as string;
  const attached = await connection.send("Target.attachToTarget", { targetId, flatten: true });
  const sessionId = attached["sessionId"] as string;

  let loaded = false;
  let resolveLoad: (() => void) | null = null;
  const loadPromise = new Promise<void>((resolve) => { resolveLoad = resolve; });

  connection.on((method, params, eventSession) => {
    if (eventSession !== sessionId) return;
    switch (method) {
      case "Page.loadEventFired":
        loaded = true;
        resolveLoad?.();
        break;
      case "Runtime.exceptionThrown": {
        const details = (params["exceptionDetails"] as Record<string, unknown>) ?? {};
        const text = String(details["text"] ?? "Uncaught exception");
        const exception = (details["exception"] as Record<string, unknown>) ?? {};
        const description = typeof exception["description"] === "string" ? exception["description"] : "";
        push(report.pageExceptions, description || text);
        break;
      }
      case "Runtime.consoleAPICalled": {
        if (params["type"] !== "error") break;
        const args = (params["args"] as Array<Record<string, unknown>>) ?? [];
        const rendered = args
          .map((arg) => String(arg["value"] ?? arg["description"] ?? arg["type"] ?? ""))
          .filter(Boolean)
          .join(" ");
        push(report.consoleErrors, rendered || "console.error()");
        break;
      }
      case "Log.entryAdded": {
        const entry = (params["entry"] as Record<string, unknown>) ?? {};
        if (entry["level"] !== "error") break;
        push(report.consoleErrors, String(entry["text"] ?? "log error"));
        break;
      }
      case "Network.responseReceived": {
        const type = params["type"];
        const response = (params["response"] as Record<string, unknown>) ?? {};
        if (type === "Document" && report.httpStatus === undefined) {
          report.httpStatus = Number(response["status"]);
        }
        if (Number(response["status"]) >= 400 && (type === "Fetch" || type === "XHR")) {
          push(report.failedRequests, `HTTP ${response["status"]}: ${response["url"]}`);
        }
        break;
      }
      case "Network.loadingFailed": {
        const errorText = String(params["errorText"] ?? "failed");
        if (errorText === "net::ERR_ABORTED") break;
        push(report.failedRequests, `${params["type"] ?? "request"}: ${errorText}`);
        break;
      }
      default:
        break;
    }
  });

  try {
    await connection.send("Page.enable", {}, sessionId);
    await connection.send("Runtime.enable", {}, sessionId);
    await connection.send("Log.enable", {}, sessionId);
    await connection.send("Network.enable", {}, sessionId);
    if (input.viewport) {
      await connection.send("Emulation.setDeviceMetricsOverride", {
        width: input.viewport.width,
        height: input.viewport.height,
        deviceScaleFactor: 1,
        mobile: false,
      }, sessionId);
    }

    const navigation = await connection.send("Page.navigate", { url }, sessionId, timeoutMs);
    const navError = navigation["errorText"];
    if (typeof navError === "string" && navError.length > 0) {
      report.failure = `navigation failed: ${navError}`;
      return report;
    }

    await Promise.race([
      loadPromise,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
    if (!loaded) report.failure = `the load event never fired within ${timeoutMs}ms`;

    if (input.waitForSelector) {
      report.selectorFound = await waitForSelector(connection, sessionId, input.waitForSelector, timeoutMs);
    }
    // Frameworks hydrate after load; a short settle avoids reading an empty root.
    await new Promise((resolve) => setTimeout(resolve, Math.min(input.settleMs ?? 600, 10_000)));

    for (const action of input.actions ?? []) {
      if (ctx.signal?.aborted) { report.failure = "verification cancelled"; break; }
      if (!await waitForSelector(connection, sessionId, action.selector, timeoutMs)) {
        report.failure = `action target not found: ${action.selector}`; break;
      }
      const encoded = JSON.stringify(action);
      const outcome = await evaluate(connection, sessionId, `(() => {
        const action = ${encoded}; const element = document.querySelector(action.selector);
        if (!element) return "missing";
        if (action.type === "click") { if (element.disabled) return "disabled"; element.click(); }
        if (action.type === "fill") {
          const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(prototype, "value").set;
          setter.call(element, action.value || "");
          element.dispatchEvent(new Event("input", { bubbles: true })); element.dispatchEvent(new Event("change", { bubbles: true }));
        }
        if (action.type === "assertText" && !(element.innerText || element.textContent || "").includes(action.value || "")) return "text mismatch";
        if (action.type === "assertVisible" && (!element.getClientRects().length || getComputedStyle(element).visibility === "hidden")) return "not visible";
        return "ok";
      })()`);
      if (outcome !== "ok") { report.failure = `${action.type} ${action.selector}: ${outcome ?? "script failed"}`; break; }
      await new Promise((resolve) => setTimeout(resolve, Math.min(input.settleMs ?? 600, 10000)));
    }

    const snapshot = await evaluate(connection, sessionId, `
      (() => {
        const text = (document.body && document.body.innerText) || "";
        return JSON.stringify({
          title: document.title || "",
          text: text.slice(0, ${MAX_TEXT_CHARS}),
          textLength: text.length,
          htmlLength: document.documentElement.outerHTML.length,
        });
      })()
    `);
    if (snapshot) {
      try {
        const parsed = JSON.parse(snapshot) as {
          title: string; text: string; textLength: number; htmlLength: number;
        };
        report.title = parsed.title;
        report.textSample = parsed.text;
        report.textLength = parsed.textLength;
        if (parsed.textLength === 0 && parsed.htmlLength < 200) {
          report.failure = report.failure ?? "the page rendered no content (empty document)";
        }
      } catch { /* keep defaults */ }
    }

    for (const expected of input.expectText ?? []) {
      if (!report.textSample.includes(expected) && !(report.title ?? "").includes(expected)) {
        // The sample is capped — confirm against the live DOM before failing.
        const present = await evaluate(
          connection,
          sessionId,
          `String(((document.body && document.body.innerText) || "").includes(${JSON.stringify(expected)}))`,
        );
        if (present !== "true") report.missingText.push(expected);
      }
    }

    if (input.screenshotPath) {
      report.screenshotPath = await captureScreenshot(
        connection, sessionId, ctx, input.screenshotPath, index, total,
      );
    }

    report.ok = !report.failure
      && report.missingText.length === 0
      && report.pageExceptions.length === 0
      && report.failedRequests.length === 0
      && (input.waitForSelector ? report.selectorFound === true : true)
      && (report.httpStatus === undefined || report.httpStatus < 400);
    return report;
  } finally {
    try { await connection.send("Target.closeTarget", { targetId }); } catch { /* browser closing */ }
  }
}

function push(list: string[], value: string): void {
  const trimmed = value.trim().slice(0, 500);
  if (trimmed && list.length < 15 && !list.includes(trimmed)) list.push(trimmed);
}

async function evaluate(
  connection: CdpConnection,
  sessionId: string,
  expression: string,
): Promise<string | null> {
  try {
    const result = await connection.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, sessionId);
    const wrapper = (result["result"] as Record<string, unknown>) ?? {};
    const value = wrapper["value"];
    return value === undefined || value === null ? null : String(value);
  } catch {
    return null;
  }
}

async function waitForSelector(
  connection: CdpConnection,
  sessionId: string,
  selector: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const expression = `String(!!document.querySelector(${JSON.stringify(selector)}))`;
  while (Date.now() < deadline) {
    if (await evaluate(connection, sessionId, expression) === "true") return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

async function captureScreenshot(
  connection: CdpConnection,
  sessionId: string,
  ctx: ToolExecutionContext,
  requestedPath: string,
  index: number,
  total: number,
): Promise<string | undefined> {
  try {
    const result = await connection.send("Page.captureScreenshot", { format: "png" }, sessionId, 30_000);
    const data = result["data"];
    if (typeof data !== "string") return undefined;
    const parsed = path.parse(requestedPath);
    const finalName = total > 1
      ? path.join(parsed.dir, `${parsed.name || "page"}-${index + 1}${parsed.ext || ".png"}`)
      : requestedPath;
    const absolute = resolveWorkspacePath(ctx.cwd, finalName);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, Buffer.from(data, "base64"));
    return path.relative(ctx.cwd, absolute) || absolute;
  } catch (err) {
    logger.warn("browser.screenshot_failed", err);
    return undefined;
  }
}

function renderReport(
  reports: PageReport[],
  executable: string,
  input: BrowserVerifyInput,
): ToolResult {
  const passed = reports.filter((report) => report.ok).length;
  const allPassed = passed === reports.length && reports.length > 0;
  const lines: string[] = [
    `# Real browser verification — ${passed}/${reports.length} page${reports.length === 1 ? "" : "s"} passed`,
    `engine: ${path.basename(executable)} (headless, Chrome DevTools Protocol)`,
    "",
  ];

  for (const report of reports) {
    lines.push(`## ${report.ok ? "PASS" : "FAIL"} ${report.url}`);
    if (report.httpStatus !== undefined) lines.push(`- http status: ${report.httpStatus}`);
    if (report.title !== undefined) lines.push(`- title: ${JSON.stringify(report.title)}`);
    lines.push(`- rendered text: ${report.textLength} chars`);
    if (input.waitForSelector) {
      lines.push(`- selector ${JSON.stringify(input.waitForSelector)}: ${report.selectorFound ? "found" : "NOT FOUND"}`);
    }
    if (report.failure) lines.push(`- failure: ${report.failure}`);
    if (report.missingText.length > 0) {
      lines.push(`- MISSING expected text: ${report.missingText.map((t) => JSON.stringify(t)).join(", ")}`);
    }
    if (report.pageExceptions.length > 0) {
      lines.push("- uncaught JavaScript exceptions:");
      for (const item of report.pageExceptions) lines.push(`    ${item}`);
    }
    if (report.consoleErrors.length > 0) {
      lines.push("- console errors:");
      for (const item of report.consoleErrors) lines.push(`    ${item}`);
    }
    if (report.failedRequests.length > 0) {
      lines.push("- failed network requests:");
      for (const item of report.failedRequests) lines.push(`    ${item}`);
    }
    if (report.screenshotPath) lines.push(`- screenshot: ${report.screenshotPath}`);
    if (report.textSample) {
      lines.push("- rendered text sample:");
      lines.push("```");
      lines.push(report.textSample.slice(0, 1_200));
      lines.push("```");
    }
    lines.push("");
  }

  if (!allPassed) {
    lines.push(
      "This is real rendered-DOM evidence. Fix the failures above and re-run browser_verify; " +
      "do not report the frontend as working until every page passes.",
    );
  }

  return {
    content: lines.join("\n"),
    isError: !allPassed,
    metadata: { browserVerified: allPassed, pagesChecked: reports.length },
  };
}
