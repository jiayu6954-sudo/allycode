import fg from "fast-glob";
import type { GlobInput, ToolResult, ToolExecutionContext } from "../types/tools.js";
import { logger } from "../utils/logger.js";
import { resolveWorkspacePath } from "./path-guard.js";

const MAX_RESULTS = 500;

export async function executeGlob(
  input: GlobInput,
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  const basePath = input.path
    ? resolveWorkspacePath(ctx.cwd, input.path)
    : ctx.cwd;

  logger.debug("glob.execute", { pattern: input.pattern, basePath });

  try {
    const entries = await fg(input.pattern, {
      cwd: basePath,
      dot: false,
      onlyFiles: true,
      followSymbolicLinks: false,
      suppressErrors: true,
      stats: true,
    });

    // Sort by modification time descending (newest first)
    const sorted = (entries as Array<{ path: string; stats?: { mtimeMs: number } }>)
      .sort((a, b) => (b.stats?.mtimeMs ?? 0) - (a.stats?.mtimeMs ?? 0))
      .map((e) => e.path);

    const truncated = sorted.length > MAX_RESULTS;
    const results = sorted.slice(0, MAX_RESULTS);

    if (results.length === 0) {
      return {
        content: `No files matched pattern "${input.pattern}" in: ${basePath}`,
        isError: false,
      };
    }

    const lines = results.join("\n");
    const suffix = truncated ? `\n\n[Truncated: showing ${MAX_RESULTS} of ${sorted.length} matches]` : "";

    return {
      content: lines + suffix,
      isError: false,
      metadata: { matchCount: results.length, truncated },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("glob.error", err);
    return { content: `glob error: ${msg}`, isError: true };
  }
}
