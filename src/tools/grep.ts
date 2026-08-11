import path from "node:path";
import fs from "node:fs/promises";
import fg from "fast-glob";
import type { GrepInput, ToolResult, ToolExecutionContext } from "../types/tools.js";
import { logger } from "../utils/logger.js";
import { resolveWorkspacePath } from "./path-guard.js";

const MAX_MATCHES = 200;
const MAX_FILE_BYTES = 500_000;

export async function executeGrep(
  input: GrepInput,
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  const searchPath = input.path
    ? resolveWorkspacePath(ctx.cwd, input.path)
    : ctx.cwd;

  logger.debug("grep.execute", { pattern: input.pattern, searchPath, include: input.include });

  // Parse flags
  const caseInsensitive = input.flags?.includes("-i") ?? false;
  const filesOnly = input.flags?.includes("-l") ?? false;

  let regex: RegExp;
  try {
    regex = new RegExp(input.pattern, caseInsensitive ? "i" : "");
  } catch {
    return {
      content: `Error: Invalid regex pattern: ${input.pattern}`,
      isError: true,
    };
  }

  try {
    // Determine if searchPath is a file or directory
    const stat = await fs.stat(searchPath).catch(() => null);

    let filePaths: string[];

    if (stat?.isFile()) {
      filePaths = [searchPath];
    } else {
      const globPattern = input.include ?? "**/*";
      const entries = await fg(globPattern, {
        cwd: searchPath,
        dot: false,
        onlyFiles: true,
        followSymbolicLinks: false,
        suppressErrors: true,
        absolute: true,
      });
      filePaths = entries as string[];
    }

    const matches: string[] = [];
    const matchedFiles = new Set<string>();
    let totalMatches = 0;
    let truncated = false;

    for (const filePath of filePaths) {
      if (totalMatches >= MAX_MATCHES) {
        truncated = true;
        break;
      }

      let content: string;
      try {
        const stat = await fs.stat(filePath);
        if (stat.size > MAX_FILE_BYTES) continue; // Skip very large binary-like files
        content = await fs.readFile(filePath, "utf-8");
      } catch {
        continue; // Skip unreadable files (binary, permissions)
      }

      const relPath = path.relative(ctx.cwd, filePath);
      const lines = content.split("\n");
      let fileHasMatch = false;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (regex.test(line)) {
          fileHasMatch = true;
          if (!filesOnly) {
            matches.push(`${relPath}:${i + 1}: ${line}`);
            totalMatches++;
            if (totalMatches >= MAX_MATCHES) {
              truncated = true;
              break;
            }
          }
        }
      }

      if (fileHasMatch) {
        matchedFiles.add(relPath);
        if (filesOnly) {
          matches.push(relPath);
          totalMatches++;
        }
      }
    }

    if (matches.length === 0) {
      return { content: `No matches found for pattern: ${input.pattern}`, isError: false };
    }

    const suffix = truncated
      ? `\n\n[Truncated at ${MAX_MATCHES} matches. Narrow your search with 'include' or a more specific pattern.]`
      : "";

    return {
      content: matches.join("\n") + suffix,
      isError: false,
      metadata: { matchCount: matches.length, truncated },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("grep.error", err);
    return { content: `grep error: ${msg}`, isError: true };
  }
}
