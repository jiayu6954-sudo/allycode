/**
 * I025: git_commit tool — git-aware workflow with structured commits
 *
 * Enables the AI to create proper git commits after completing a set of changes,
 * completing the engineering delivery loop: code → test → commit.
 *
 * Inspired by Aider's git-native approach: after every logical unit of work,
 * commit with a conventional commit message so progress is tracked and reversible.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "../utils/logger.js";
import type { ToolResult, ToolExecutionContext } from "../types/tools.js";

const execFileAsync = promisify(execFile);

export interface GitCommitInput {
  message: string;
  files?: string[];   // specific files to stage; if omitted, stages all tracked changes
}

export async function executeGitCommit(
  input: GitCommitInput,
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  const { message, files } = input;

  if (!message?.trim()) {
    return { content: "Error: commit message cannot be empty", isError: true };
  }

  logger.debug("git_commit.start", { message: message.slice(0, 60), files: files?.length ?? "all" });

  try {
    // ── 1. Stage files ────────────────────────────────────────────────────
    if (files && files.length > 0) {
      await execFileAsync("git", ["add", "--", ...files], {
        cwd: ctx.cwd,
        timeout: 10_000,
      });
    } else {
      // Stage all tracked changes (not untracked — safer default)
      await execFileAsync("git", ["add", "-u"], {
        cwd: ctx.cwd,
        timeout: 10_000,
      });
    }

    // ── 2. Check if there's anything staged ──────────────────────────────
    const { stdout: statusOut } = await execFileAsync(
      "git", ["diff", "--cached", "--name-only"],
      { cwd: ctx.cwd, timeout: 5_000 },
    );
    if (!statusOut.trim()) {
      return {
        content: "Nothing to commit — no staged changes. Use git add to stage files first, or ensure files were modified.",
        isError: false,
      };
    }

    // ── 3. Commit ─────────────────────────────────────────────────────────
    const { stdout: commitOut } = await execFileAsync(
      "git", ["commit", "-m", message],
      { cwd: ctx.cwd, timeout: 15_000 },
    );

    // ── 4. Get short stats ────────────────────────────────────────────────
    let statsOut = "";
    try {
      const { stdout } = await execFileAsync(
        "git", ["show", "--stat", "--oneline", "HEAD"],
        { cwd: ctx.cwd, timeout: 5_000 },
      );
      statsOut = stdout.trim();
    } catch { /* stats are informational */ }

    logger.info("git_commit.success", { message: message.slice(0, 60) });

    return {
      content: [
        commitOut.trim(),
        statsOut ? `\n${statsOut}` : "",
      ].join(""),
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("git_commit.failed", { error: msg });
    return { content: `Git commit failed: ${msg}`, isError: true };
  }
}
