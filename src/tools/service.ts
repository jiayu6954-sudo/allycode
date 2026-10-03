import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type {
  ServiceStartInput,
  ServiceStatusInput,
  ServiceStopInput,
  ToolExecutionContext,
  ToolResult,
} from "../types/tools.js";
import { logger } from "../utils/logger.js";

/**
 * Long-running service manager.
 *
 * The shell tool deliberately terminates its whole child-process tree at the
 * declared timeout, which makes it structurally unable to leave a dev server or
 * API running. Every frontend task therefore dead-ended: the model started a
 * server, the tool killed it on the way out, and no UI could ever be verified.
 *
 * A service is spawned with its stdio redirected to a log FILE rather than an
 * inherited pipe. Nothing in the parent stays open, so the tool returns
 * immediately while the process keeps running across model turns.
 */

const SERVICES = new Map<string, ServiceRecord>();
const DEFAULT_READY_TIMEOUT_MS = 60_000;
const MAX_READY_TIMEOUT_MS = 300_000;
const LOG_TAIL_CHARS = 4_000;
const MAX_SERVICES = 8;

interface ServiceRecord {
  name: string;
  cwd: string;
  command: string;
  pid: number | undefined;
  logPath: string;
  startedAt: number;
  child: ChildProcess;
  exitCode: number | null;
  exitSignal: string | null;
}

function key(cwd: string, name: string): string {
  return `${path.resolve(cwd).toLowerCase()}::${name}`;
}

function logDir(cwd: string): string {
  return path.join(cwd, ".allycode", "services");
}

/** URLs a dev server prints on startup — the most reliable port evidence. */
function extractUrls(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d+[^\s"'`,)\]]*/gi)) {
    found.add(match[0].replace(/[.,;]+$/, ""));
  }
  return [...found].slice(0, 8);
}

function readLogTail(logPath: string, chars = LOG_TAIL_CHARS): string {
  try {
    const raw = fs.readFileSync(logPath, "utf8");
    return raw.length > chars ? `…(truncated)\n${raw.slice(-chars)}` : raw;
  } catch {
    return "";
  }
}

function isAlive(record: ServiceRecord): boolean {
  if (record.exitCode !== null || record.exitSignal !== null) return false;
  if (!record.pid) return false;
  try {
    process.kill(record.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function terminate(record: ServiceRecord): void {
  const pid = record.pid;
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill.exe", ["/pid", String(pid), "/t", "/f"], {
        windowsHide: true,
        timeout: 5_000,
      });
    } else {
      // detached:true put the child in its own group — kill the whole group.
      try { process.kill(-pid, "SIGTERM"); } catch { record.child.kill("SIGTERM"); }
      setTimeout(() => {
        try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
      }, 3_000).unref?.();
    }
  } catch (err) {
    logger.warn("service.terminate_failed", { pid, err });
  }
}

/**
 * taskkill returns before Windows has finished tearing the tree down, and the
 * listening socket outlives the process by a moment. Restarting on the same
 * port immediately after a stop would then fail with EADDRINUSE, or worse,
 * briefly reach the dying server and read it as healthy.
 */
async function waitForExit(record: ServiceRecord, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(record)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isAlive(record);
}

/**
 * Stop every tracked service and wait for the processes to actually go away.
 *
 * The synchronous variant only fires taskkill; a caller that then deletes the
 * workspace races the dying process and gets EBUSY on Windows, because the
 * child still holds its working directory and log file open.
 */
export async function stopAllServicesAndWait(cwd?: string): Promise<number> {
  const doomed = [...SERVICES.values()].filter((record) =>
    !cwd || path.resolve(record.cwd).toLowerCase() === path.resolve(cwd).toLowerCase());
  const stopped = stopAllServices(cwd);
  await Promise.all(doomed.map((record) => waitForExit(record)));
  return stopped;
}

/** Stop every tracked service. Called when a task ends, aborts, or the process exits. */
export function stopAllServices(cwd?: string): number {
  let stopped = 0;
  for (const [id, record] of [...SERVICES]) {
    if (cwd && path.resolve(record.cwd).toLowerCase() !== path.resolve(cwd).toLowerCase()) continue;
    terminate(record);
    SERVICES.delete(id);
    stopped++;
  }
  return stopped;
}

let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  const cleanup = (): void => { stopAllServices(); };
  process.once("exit", cleanup);
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);
}

async function waitForUrl(
  url: string,
  timeoutMs: number,
  record: ServiceRecord,
  signal?: AbortSignal,
): Promise<{ ready: boolean; status?: number; reason?: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    if (signal?.aborted) return { ready: false, reason: "aborted by user" };
    if (!isAlive(record)) {
      return {
        ready: false,
        reason: `the process exited early with code ${record.exitCode ?? "unknown"}`,
      };
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.status < 500) {
        // A listener answering on that port is not proof that OUR process is
        // the one serving it. An orphan from an earlier run holds the port,
        // our process dies with EADDRINUSE, and the health check succeeds
        // against the stranger — reporting a service we never started.
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (!isAlive(record)) {
          return { ready: false, reason: portConflictReason(record) };
        }
        return { ready: true, status: response.status };
      }
      lastError = `HTTP ${response.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return { ready: false, reason: `not ready within ${timeoutMs}ms (last: ${lastError || "no response"})` };
}

/** Name the likely cause when a process dies while its port answers. */
function portConflictReason(record: ServiceRecord): string {
  const log = readLogTail(record.logPath, 2_000);
  if (/EADDRINUSE|address already in use/i.test(log)) {
    return "the port is already held by ANOTHER process — the health URL answered, but that was the other " +
      "process, and this one exited with EADDRINUSE. Stop whatever owns the port, or choose a different one";
  }
  return `the process exited (code ${record.exitCode ?? "unknown"}) even though the health URL answered — ` +
    "another process is likely serving that port";
}

export async function executeServiceStart(
  input: ServiceStartInput,
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  installExitHook();
  const cwd = ctx.cwd;
  const name = input.name.trim();
  if (!/^[\w.-]{1,64}$/.test(name)) {
    return {
      content: "Invalid service name. Use letters, digits, dot, dash or underscore (max 64 chars), e.g. \"api\" or \"web\".",
      isError: true,
    };
  }

  const existing = SERVICES.get(key(cwd, name));
  if (existing && isAlive(existing)) {
    return {
      content: [
        `Service "${name}" is ALREADY RUNNING (pid ${existing.pid}, started ${new Date(existing.startedAt).toISOString()}).`,
        `Command: ${existing.command}`,
        "Do not start it again. Use service_status to inspect it, or service_stop first if you must restart.",
        "",
        "Recent log:",
        readLogTail(existing.logPath, 1_500) || "(no output yet)",
      ].join("\n"),
      isError: false,
      metadata: { serviceName: name, servicePid: existing.pid },
    };
  }
  if (existing) SERVICES.delete(key(cwd, name));

  const liveCount = [...SERVICES.values()].filter(isAlive).length;
  if (liveCount >= MAX_SERVICES) {
    return {
      content: `Too many background services running (${liveCount}). Stop unused ones with service_stop before starting another.`,
      isError: true,
    };
  }

  const directory = logDir(cwd);
  fs.mkdirSync(directory, { recursive: true });
  const logPath = path.join(directory, `${name}.log`);
  // A fresh log per start; a stale tail would otherwise read as current evidence.
  fs.writeFileSync(logPath, `# ${name} — ${input.command}\n# started ${new Date().toISOString()}\n`, "utf8");
  const logFd = fs.openSync(logPath, "a");

  const [shell, shellArgs] = process.platform === "win32"
    ? [process.env["ComSpec"] ?? "cmd.exe", ["/d", "/s", "/c", input.command]]
    : ["/bin/sh", ["-c", input.command]];

  let child: ChildProcess;
  try {
    child = spawn(shell, shellArgs, {
      cwd,
      env: { ...process.env, ...(input.env ?? {}) },
      // stdio goes to a FILE, never an inherited pipe. This is what lets the
      // tool return while the service keeps running.
      stdio: ["ignore", logFd, logFd],
      // On Windows `detached` means CREATE_NEW_CONSOLE: the child would get a
      // fresh console and its output would bypass the inherited log handle,
      // leaving the model blind to startup errors. Windows children already
      // survive the parent, and the explicit taskkill tree handles shutdown.
      // On POSIX the new process group is what makes group-kill work.
      detached: process.platform !== "win32",
      windowsHide: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Failed to spawn service "${name}": ${msg}`, isError: true };
  } finally {
    // The child inherited its own handle; release the parent's copy.
    try { fs.closeSync(logFd); } catch { /* already released */ }
  }

  const record: ServiceRecord = {
    name,
    cwd,
    command: input.command,
    pid: child.pid,
    logPath,
    startedAt: Date.now(),
    child,
    exitCode: null,
    exitSignal: null,
  };
  child.on("exit", (code, signal) => {
    record.exitCode = code;
    record.exitSignal = signal;
  });
  child.unref();
  SERVICES.set(key(cwd, name), record);
  logger.info("service.started", { name, pid: child.pid, command: input.command });

  const relativeLog = path.relative(cwd, logPath) || logPath;
  const readyTimeout = Math.min(input.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS, MAX_READY_TIMEOUT_MS);

  if (input.readyUrl) {
    const outcome = await waitForUrl(input.readyUrl, readyTimeout, record, ctx.signal);
    const tail = readLogTail(logPath);
    const urls = extractUrls(tail);
    if (!outcome.ready) {
      const died = !isAlive(record);
      if (died) SERVICES.delete(key(cwd, name));
      return {
        content: [
          `Service "${name}" did not become ready: ${outcome.reason}.`,
          `Command: ${input.command}`,
          `Log file: ${relativeLog}`,
          urls.length > 0 ? `URLs printed by the process: ${urls.join(", ")}` : "",
          died
            ? "The process is NOT running. Read the log below, fix the root cause, then start it again."
            : "The process IS still running but the health URL never answered. Check the port, the host binding (use 127.0.0.1, not just localhost) and the path.",
          "",
          "Log:",
          tail || "(no output)",
        ].filter(Boolean).join("\n"),
        isError: true,
        metadata: { serviceName: name, servicePid: record.pid },
      };
    }
    return {
      content: [
        `Service "${name}" is RUNNING and READY.`,
        `pid=${record.pid}  health=${input.readyUrl} → HTTP ${outcome.status}`,
        `Command: ${input.command}`,
        `Log file: ${relativeLog} (read it with file_read, or use service_status)`,
        urls.length > 0 ? `URLs printed by the process: ${urls.join(", ")}` : "",
        "It keeps running across turns. Verify the UI with browser_verify, then call service_stop when finished.",
        "",
        "Startup log:",
        readLogTail(logPath, 1_500) || "(no output yet)",
      ].filter(Boolean).join("\n"),
      isError: false,
      metadata: { serviceName: name, servicePid: record.pid },
    };
  }

  // No health URL: give the process a moment, then report whether it survived.
  await new Promise((resolve) => setTimeout(resolve, Math.min(input.readyTimeoutMs ?? 2_000, 15_000)));
  const tail = readLogTail(logPath);
  const urls = extractUrls(tail);
  if (!isAlive(record)) {
    SERVICES.delete(key(cwd, name));
    return {
      content: [
        `Service "${name}" EXITED immediately with code ${record.exitCode ?? "unknown"}.`,
        `Command: ${input.command}`,
        `Log file: ${relativeLog}`,
        "",
        "Log:",
        tail || "(no output)",
      ].join("\n"),
      isError: true,
      metadata: { serviceName: name, exitCode: record.exitCode ?? undefined },
    };
  }
  return {
    content: [
      `Service "${name}" is RUNNING (pid ${record.pid}).`,
      "No readyUrl was given, so readiness is UNVERIFIED — pass readyUrl next time to prove the listener is up.",
      `Log file: ${relativeLog}`,
      urls.length > 0 ? `URLs printed by the process: ${urls.join(", ")}` : "",
      "",
      "Log so far:",
      tail || "(no output yet)",
    ].filter(Boolean).join("\n"),
    isError: false,
    metadata: { serviceName: name, servicePid: record.pid },
  };
}

export async function executeServiceStatus(
  input: ServiceStatusInput,
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  const cwd = ctx.cwd;
  const records = [...SERVICES.values()].filter(
    (record) => path.resolve(record.cwd).toLowerCase() === path.resolve(cwd).toLowerCase(),
  );
  const selected = input.name
    ? records.filter((record) => record.name === input.name)
    : records;

  if (selected.length === 0) {
    return {
      content: input.name
        ? `No service named "${input.name}" has been started in this project. Use service_start first.`
        : "No background services are running in this project.",
      isError: false,
    };
  }

  const tailChars = Math.min(input.logChars ?? LOG_TAIL_CHARS, 20_000);
  const sections = selected.map((record) => {
    const alive = isAlive(record);
    const tail = readLogTail(record.logPath, tailChars);
    const urls = extractUrls(tail);
    return [
      `## ${record.name} — ${alive ? "RUNNING" : `STOPPED (exit ${record.exitCode ?? record.exitSignal ?? "unknown"})`}`,
      `pid=${record.pid ?? "n/a"}  uptime=${Math.round((Date.now() - record.startedAt) / 1000)}s`,
      `command: ${record.command}`,
      `log: ${path.relative(cwd, record.logPath) || record.logPath}`,
      urls.length > 0 ? `urls: ${urls.join(", ")}` : "",
      "",
      "```",
      tail || "(no output)",
      "```",
    ].filter(Boolean).join("\n");
  });

  return { content: sections.join("\n\n"), isError: false };
}

export async function executeServiceStop(
  input: ServiceStopInput,
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  const cwd = ctx.cwd;
  if (input.all) {
    const doomed = [...SERVICES.values()].filter(
      (record) => path.resolve(record.cwd).toLowerCase() === path.resolve(cwd).toLowerCase(),
    );
    const stopped = stopAllServices(cwd);
    await Promise.all(doomed.map((record) => waitForExit(record)));
    return {
      content: stopped > 0
        ? `Stopped ${stopped} background service${stopped === 1 ? "" : "s"} in this project. Their ports are free again.`
        : "No background services were running in this project.",
      isError: false,
    };
  }
  if (!input.name) {
    return { content: "service_stop needs either a name or all=true.", isError: true };
  }
  const id = key(cwd, input.name);
  const record = SERVICES.get(id);
  if (!record) {
    return { content: `No service named "${input.name}" is tracked in this project.`, isError: false };
  }
  const wasAlive = isAlive(record);
  terminate(record);
  SERVICES.delete(id);
  const gone = await waitForExit(record);
  return {
    content: wasAlive
      ? `Stopped service "${input.name}" (pid ${record.pid}) and its child processes.` +
        (gone ? " Its port is free again." : " The process has not exited yet; check for a surviving child before reusing its port.")
      : `Service "${input.name}" had already exited (code ${record.exitCode ?? "unknown"}); its record was cleared.`,
    isError: false,
  };
}

/** Evidence for the completion gate: services that actually reached a healthy state. */
export function listServiceNames(cwd: string): string[] {
  return [...SERVICES.values()]
    .filter((record) => path.resolve(record.cwd).toLowerCase() === path.resolve(cwd).toLowerCase())
    .map((record) => record.name);
}
