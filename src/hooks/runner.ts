/**
 * I027: Hooks System — PreToolUse / PostToolUse shell hooks
 *
 * Claude Code inspiration: PreToolUse / PostToolUse hooks let users plug
 * custom shell commands into the tool execution pipeline.
 *
 * Configuration in ~/.allycode/settings.json:
 * {
 *   "hooks": {
 *     "preToolUse": [
 *       { "tool": "file_write", "command": "npx tsc --noEmit 2>&1 | head -20" }
 *     ],
 *     "postToolUse": [
 *       { "tool": "file_write", "command": "npx eslint ${path} --max-warnings 0 2>&1 | tail -10" },
 *       { "tool": "*",          "command": "echo '[hook] ${toolName} completed'" }
 *     ]
 *   }
 * }
 *
 * Template variables available in commands:
 *   ${toolName}  — name of the tool being executed
 *   ${path}      — file path (for file_read/write/edit/glob/grep)
 *   ${command}   — bash command (for bash tool)
 *   ${query}     — search query (for web_search)
 *   ${url}       — URL (for web_fetch)
 *   ${cwd}       — current working directory
 *
 * Hook output is appended to the tool result so the AI can react to it
 * (e.g. fix a lint error that appeared after a file_write).
 *
 * failBehavior:
 *   "warn"  (default) — non-zero exit is noted but tool result still returned
 *   "block" — non-zero exit converts the tool result to an error, blocking the AI
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "../utils/logger.js";

const execFileAsync = promisify(execFile);

const SHELL = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
const SHELL_ARGS = process.platform === "win32"
  ? ["-NoProfile", "-NonInteractive", "-Command"]
  : ["-c"];
const HOOK_TIMEOUT_MS = 15_000;
const MAX_HOOK_OUTPUT = 2_000; // chars — hooks are informational, not full output

export interface HookDef {
  tool: string;             // tool name to match, or "*" for all tools
  command: string;          // shell command (supports ${var} templates)
  failBehavior?: "warn" | "block";
}

export interface HooksConfig {
  preToolUse?: HookDef[];
  postToolUse?: HookDef[];
}

export interface HookRunResult {
  output: string;
  exitCode: number;
  blocked: boolean;         // true if failBehavior=block and hook failed
}

// ── Template substitution ─────────────────────────────────────────────────────

function substituteTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(
    /\$\{(\w+)\}/g,
    (_, key: string) => shellQuote(vars[key] ?? ""),
  );
}

export function shellQuote(value: string): string {
  if (process.platform === "win32") {
    return `'${value.replace(/'/g, "''")}'`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function extractVars(
  toolName: string,
  input: unknown,
  cwd: string,
): Record<string, string> {
  const inp = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  return {
    toolName,
    cwd,
    path:    String(inp["path"]    ?? inp["url"]   ?? ""),
    command: String(inp["command"] ?? ""),
    query:   String(inp["query"]   ?? ""),
    url:     String(inp["url"]     ?? ""),
  };
}

// ── Hook matcher ──────────────────────────────────────────────────────────────

function matchesHook(def: HookDef, toolName: string): boolean {
  return def.tool === "*" || def.tool === toolName;
}

// ── Run a single hook command ─────────────────────────────────────────────────

async function runHookCommand(
  command: string,
  vars: Record<string, string>,
): Promise<{ output: string; exitCode: number }> {
  const resolved = substituteTemplate(command, vars);
  try {
    const { stdout, stderr } = await execFileAsync(
      SHELL,
      [...SHELL_ARGS, resolved],
      {
        cwd: vars["cwd"],
        timeout: HOOK_TIMEOUT_MS,
        maxBuffer: 512 * 1024,
      },
    );
    const raw = [stdout, stderr].filter(Boolean).join("\n").trim();
    const output = raw.length > MAX_HOOK_OUTPUT
      ? raw.slice(0, MAX_HOOK_OUTPUT) + "\n[hook output truncated]"
      : raw;
    return { output, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
    const raw = [e.stdout, e.stderr].filter(Boolean).join("\n").trim();
    const output = (raw || e.message || String(err)).slice(0, MAX_HOOK_OUTPUT);
    return { output, exitCode: e.code ?? 1 };
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run all matching pre-tool hooks.
 * Returns combined output and whether the tool should be blocked.
 */
export async function runPreToolHooks(
  hooks: HooksConfig,
  toolName: string,
  input: unknown,
  cwd: string,
): Promise<HookRunResult> {
  const defs = (hooks.preToolUse ?? []).filter((d) => matchesHook(d, toolName));
  if (defs.length === 0) return { output: "", exitCode: 0, blocked: false };

  const vars = extractVars(toolName, input, cwd);
  const outputs: string[] = [];
  let blocked = false;

  for (const def of defs) {
    logger.debug("hook.pre_tool_use.run", { tool: toolName, command: def.command.slice(0, 60) });
    const result = await runHookCommand(def.command, vars);
    if (result.output) outputs.push(`[pre-hook: ${def.command.slice(0, 40)}]\n${result.output}`);
    if (result.exitCode !== 0 && def.failBehavior === "block") {
      blocked = true;
      logger.warn("hook.pre_tool_use.blocked", { tool: toolName, exitCode: result.exitCode });
    }
  }

  return { output: outputs.join("\n\n"), exitCode: 0, blocked };
}

/**
 * Run all matching post-tool hooks.
 * Returns combined output and whether the tool result should be converted to an error.
 */
export async function runPostToolHooks(
  hooks: HooksConfig,
  toolName: string,
  input: unknown,
  cwd: string,
): Promise<HookRunResult> {
  const defs = (hooks.postToolUse ?? []).filter((d) => matchesHook(d, toolName));
  if (defs.length === 0) return { output: "", exitCode: 0, blocked: false };

  const vars = extractVars(toolName, input, cwd);
  const outputs: string[] = [];
  let blocked = false;

  for (const def of defs) {
    logger.debug("hook.post_tool_use.run", { tool: toolName, command: def.command.slice(0, 60) });
    const result = await runHookCommand(def.command, vars);
    if (result.output) outputs.push(`[post-hook: ${def.command.slice(0, 40)}]\n${result.output}`);
    if (result.exitCode !== 0 && def.failBehavior === "block") {
      blocked = true;
      logger.warn("hook.post_tool_use.blocked", { tool: toolName, exitCode: result.exitCode });
    }
  }

  return { output: outputs.join("\n\n"), exitCode: 0, blocked };
}
