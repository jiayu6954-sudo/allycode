import { EvidenceStore } from "../storage/evidence-store.js";
import { execa } from "execa";
import { spawnSync } from "node:child_process";
import type { BashInput, ToolResult, ToolExecutionContext } from "../types/tools.js";
import { logger } from "../utils/logger.js";

/** I009-F: Match Claude Code's BASH_MAX_OUTPUT_DEFAULT — char-based, not byte-based */
const MAX_OUTPUT_CHARS = 30_000;
const DEFAULT_TIMEOUT_MS = 30_000;
/** Dependency installs and cold builds legitimately exceed five minutes. Capping
 *  them lower forced a timeout kill that the model could only read as failure. */
const MAX_TIMEOUT_MS = 900_000;

export async function executeBash(
  input: BashInput,
  ctx: ToolExecutionContext,
  onProgress?: (chunk: string) => void
): Promise<ToolResult> {
  const timeoutMs = Math.min(
    input.timeout ?? DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS
  );

  logger.debug("bash.execute", { command: input.command, timeoutMs });

  if (process.platform === "win32" && /(?:^|\n)[^\n]*\bpython(?:3)?\s+-\s*<<\s*['"]?\w+/i.test(input.command)) {
    return { isError: true, content: "当前 bash 工具实际使用 Windows PowerShell，不支持 Python 的 Bash heredoc（python - <<）。请用 file_write 保存 .py，再单独运行 python 脚本路径；不要管道截断或用后续打印掩盖退出码。", metadata: { exitCode: 2 } };
  }

  let timedOut = false;
  let aborted = false;
  let capturedOutput = "";

  try {
    // On Windows use PowerShell (always available on Win10/11).
    // Wrap the user command in $null = ... or Out-Null for noisy cmdlets so
    // AI doesn't mistake verbose directory/file metadata for an error.
    // -NoProfile -NonInteractive: faster startup, no blocking prompts.
    const [shell, shellArgs] = process.platform === "win32"
      ? ["powershell.exe", [
          "-NoProfile", "-NonInteractive",
          "-Command",
          // Set ErrorActionPreference so errors surface as text (exit 1)
          // rather than red-stream exceptions that don't reach 'all'.
          "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; " +
          "[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding; " +
          "$env:PYTHONIOENCODING='utf-8'; $env:PYTHONUTF8='1'; $global:LASTEXITCODE=0; " +
          input.command + "\n$allyCommandSucceeded=$?; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; if (-not $allyCommandSucceeded) { exit 1 }",
        ]]
      : ["bash", ["-c", input.command]];

    const subprocess = execa(shell, shellArgs, {
      cwd: ctx.cwd,
      windowsHide: true,
      reject: false,           // Don't throw on non-zero exit
      all: true,               // Combine stdout + stderr into `all`
      maxBuffer: MAX_OUTPUT_CHARS * 4, // bytes; 4× for worst-case UTF-8
      cleanup: true,           // Kill child on parent exit
      // On Windows, terminating PowerShell alone can leave npm/Node children
      // holding the stdio pipe forever. The explicit tree guard below handles
      // timeout and cancellation there; other platforms retain execa's guard.
      ...(process.platform === "win32"
        ? {}
        : {
            timeout: timeoutMs,
            cancelSignal: ctx.signal as AbortSignal | undefined,
      }),
    });

    type GuardOutcome = { kind: "guard"; reason: "timeout" | "abort" };
    let resolveGuard!: (outcome: GuardOutcome) => void;
    let guardResolved = false;
    const guard = new Promise<GuardOutcome>((resolve) => {
      resolveGuard = resolve;
    });

    const terminate = (reason: "timeout" | "abort"): void => {
      if (guardResolved) return;
      guardResolved = true;
      if (reason === "timeout") timedOut = true;
      else aborted = true;
      const pid = subprocess.pid;
      if (pid) {
        if (process.platform === "win32") {
          terminateWindowsProcessTree(pid, reason);
        } else {
          subprocess.kill("SIGTERM");
        }
      }

      // A detached child may keep the inherited stdout/stderr pipe open after
      // the shell process has already exited. Never let that pipe keep the
      // Agent tool promise pending beyond its declared timeout.
      subprocess.stdin?.destroy();
      subprocess.stdout?.destroy();
      subprocess.stderr?.destroy();
      subprocess.all?.destroy();
      resolveGuard({ kind: "guard", reason });
    };
    const timeoutHandle = process.platform === "win32"
      ? setTimeout(() => terminate("timeout"), timeoutMs)
      : undefined;
    const abortHandler = (): void => terminate("abort");
    if (process.platform === "win32") {
      if (ctx.signal?.aborted) abortHandler();
      else ctx.signal?.addEventListener("abort", abortHandler, { once: true });
    }

    // Capture partial output independently from execa's completion promise.
    // This lets us return useful diagnostics even when a detached descendant
    // keeps execa's stdio aggregation open indefinitely.
    if (subprocess.all) {
      const FLUSH_INTERVAL_MS = 2_000;
      const FLUSH_BYTES = 2_048;
      let buf = "";
      let timer: ReturnType<typeof setTimeout> | null = null;

      const flush = (): void => {
        if (timer) { clearTimeout(timer); timer = null; }
        if (buf.length > 0 && onProgress) onProgress(buf);
        buf = "";
      };

      subprocess.all.on("data", (chunk: Buffer | string) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        if (capturedOutput.length <= MAX_OUTPUT_CHARS) {
          capturedOutput += text.slice(0, MAX_OUTPUT_CHARS + 1 - capturedOutput.length);
        }
        if (onProgress) {
          buf += text;
          if (buf.length >= FLUSH_BYTES) {
            flush();
          } else if (!timer) {
            timer = setTimeout(flush, FLUSH_INTERVAL_MS);
          }
        }
      });

      subprocess.all.once("end", flush);
      subprocess.all.once("close", flush);
    }

    const completion = subprocess.then(
      (result) => ({ kind: "result" as const, result }),
      (error: unknown) => ({ kind: "error" as const, error }),
    );
    let outcome: Awaited<typeof completion> | GuardOutcome;
    try {
      outcome = await Promise.race([completion, guard]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      ctx.signal?.removeEventListener("abort", abortHandler);
    }

    if (outcome.kind === "guard") {
      const truncated = capturedOutput.length > MAX_OUTPUT_CHARS;
      const output = truncated
        ? capturedOutput.slice(0, MAX_OUTPUT_CHARS)
        : capturedOutput;
      if (outcome.reason === "abort") {
        return {
          content: [
            output,
            "Command aborted by user. The child-process tree was terminated and the tool returned control.",
          ].filter(Boolean).join("\n"),
          isError: true,
        };
      }
      return {
        content: [
          output,
          `Command timed out after ${timeoutMs}ms. The child-process tree was terminated and the tool returned control.`,
          "Do not retry the identical command. Check for watch mode, a server/start script being discovered as a test, or another process that intentionally stays alive.",
        ].filter(Boolean).join("\n"),
        isError: true,
        metadata: { exitCode: 124, truncated },
      };
    }
    if (outcome.kind === "error") throw outcome.error;
    const result = outcome.result;

    const rawOutput = result.all ?? result.stdout + result.stderr;
    const evidenceId = await new EvidenceStore(ctx.cwd).put(rawOutput);
    const truncated = rawOutput.length > MAX_OUTPUT_CHARS;
    const output = truncated ? rawOutput.slice(0, MAX_OUTPUT_CHARS) : rawOutput;

    if (aborted) {
      return {
        content: "Command aborted by user. The complete child-process tree was terminated.",
        isError: true,
      };
    }
    if (timedOut) {
      return {
        content: [
          output,
          `Command timed out after ${timeoutMs}ms. The complete child-process tree was terminated.`,
          "Do not retry the identical command. Check for watch mode, a server/start script being discovered as a test, or another process that intentionally stays alive.",
        ].filter(Boolean).join("\n"),
        isError: true,
        metadata: { exitCode: 124, truncated },
      };
    }

    const content = [
      output.length > 0 ? output : "(no output)",
      truncated ? `\n[Output truncated at ${MAX_OUTPUT_CHARS.toLocaleString()} chars]` : "",
      `\n[Exit code: ${result.exitCode ?? "unknown"}]`,
    ]
      .filter(Boolean)
      .join("");

    logger.debug("bash.result", {
      exitCode: result.exitCode,
      outputLen: rawOutput.length,
      truncated,
    });

    return {
      content,
      // A signal-terminated process has a null exitCode. It is not success.
      isError: result.exitCode !== 0,
      metadata: {
        exitCode: result.exitCode ?? undefined,
        evidenceId,
        truncated,
      },
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { content: "Command aborted by user.", isError: true };
    }
    if (err instanceof Error && err.message.includes("timed out")) {
      return {
        content: `Command timed out after ${timeoutMs}ms.`,
        isError: true,
        metadata: { exitCode: 124 },
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("bash.error", err);
    return { content: `bash error: ${msg}`, isError: true };
  }
}

/**
 * Terminate descendants even when the original PowerShell launcher has
 * already exited. Windows retains ParentProcessId on surviving processes, so
 * a snapshot can still recover a detached Start-Process/npm tree.
 */
function terminateWindowsProcessTree(rootPid: number, reason: "timeout" | "abort"): void {
  const descendants = findWindowsDescendantPids(rootPid);
  const targets = [rootPid, ...descendants.reverse()];
  const statuses: Array<{ pid: number; status: number | null }> = [];
  for (const pid of targets) {
    const killed = spawnSync(
      "taskkill.exe",
      ["/pid", String(pid), "/t", "/f"],
      { windowsHide: true, encoding: "utf8", timeout: 5_000 },
    );
    statuses.push({ pid, status: killed.status });
  }
  logger.info("bash.process_tree_terminated", {
    pid: rootPid,
    reason,
    descendants,
    statuses,
  });
}

function findWindowsDescendantPids(rootPid: number): number[] {
  const script = [
    `$root = ${rootPid}`,
    "$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)",
    "$found = @()",
    "$frontier = @($root)",
    "do {",
    "  $next = @($all | Where-Object { $frontier -contains [int]$_.ParentProcessId } | ForEach-Object { [int]$_.ProcessId } | Where-Object { $_ -ne $root -and $found -notcontains $_ })",
    "  $found += $next",
    "  $frontier = $next",
    "} while ($frontier.Count -gt 0)",
    "$found | ConvertTo-Json -Compress",
  ].join("; ");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, encoding: "utf8", timeout: 5_000 },
  );
  if (result.status !== 0 || !result.stdout.trim()) return [];
  try {
    const parsed = JSON.parse(result.stdout.trim()) as number | number[];
    const values = Array.isArray(parsed) ? parsed : [parsed];
    return values.filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== rootPid);
  } catch {
    logger.warn("bash.process_tree_discovery_failed", {
      pid: rootPid,
      status: result.status,
      output: result.stdout.slice(0, 500),
    });
    return [];
  }
}
