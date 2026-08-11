import fs from "node:fs/promises";
import type { FileEditInput, ToolResult, ToolExecutionContext } from "../types/tools.js";
import { logger } from "../utils/logger.js";
import { resolveWorkspacePath } from "./path-guard.js";

export async function executeFileEdit(
  input: FileEditInput,
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  const filePath = resolveWorkspacePath(ctx.cwd, input.path);
  logger.debug("file_edit.execute", { path: filePath });

  if (input.oldString === input.newString) {
    return { content: "Error: oldString and newString are identical — no change needed.", isError: true };
  }

  try {
    const content = await fs.readFile(filePath, "utf-8");

    // Count occurrences to enforce uniqueness
    const count = countOccurrences(content, input.oldString);

    if (count === 0) {
      // Provide a helpful diagnostic: show surrounding context if possible
      const hint = findClosestMatch(content, input.oldString);
      return {
        content: [
          `Error: oldString not found in ${input.path}.`,
          hint ? `\nClosest match found:\n${hint}` : "",
          "\nUse file_read to verify the exact content before editing.",
        ]
          .filter(Boolean)
          .join(""),
        isError: true,
      };
    }

    if (count > 1) {
      return {
        content: `Error: oldString appears ${count} times in ${input.path}. Provide more context to make it unique.`,
        isError: true,
      };
    }

    const updated = content.replace(input.oldString, input.newString);
    await fs.writeFile(filePath, updated, "utf-8");

    return {
      content: buildDiff(input.oldString, input.newString, input.path, content),
      isError: false,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { content: `Error: File not found: ${input.path}`, isError: true };
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("file_edit.error", err);
    return { content: `file_edit error: ${msg}`, isError: true };
  }
}

// ── Diff renderer ─────────────────────────────────────────────────────────

const MAX_DIFF_LINES = 30;

/**
 * Builds a unified-style diff string for display in the terminal.
 * Lines are prefixed with "- " (removed) or "+ " (added).
 * ToolCall.tsx colours them red/green by matching the prefix.
 */
function buildDiff(
  oldStr: string,
  newStr: string,
  filePath: string,
  fileContent: string
): string {
  // Compute start line number in the file
  const editOffset = fileContent.indexOf(oldStr);
  const startLine = editOffset === -1
    ? 1
    : fileContent.slice(0, editOffset).split("\n").length;

  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");

  const removed = oldLines.map((l) => `- ${l}`);
  const added   = newLines.map((l) => `+ ${l}`);
  const allDiff = [...removed, ...added];

  const truncated = allDiff.length > MAX_DIFF_LINES;
  const display   = truncated ? allDiff.slice(0, MAX_DIFF_LINES) : allDiff;

  const header  = `── ${filePath} (line ${startLine}) ──`;
  const trailer = truncated
    ? `[+${allDiff.length - MAX_DIFF_LINES} more lines not shown]`
    : "";

  return [header, ...display, trailer].filter(Boolean).join("\n");
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

// Returns a snippet of the file around the closest approximate match
function findClosestMatch(content: string, target: string): string | null {
  const firstLine = target.split("\n")[0]?.trim() ?? "";
  if (!firstLine) return null;
  const lineIdx = content.split("\n").findIndex((l) => l.includes(firstLine));
  if (lineIdx === -1) return null;
  const lines = content.split("\n");
  const start = Math.max(0, lineIdx - 1);
  const end = Math.min(lines.length - 1, lineIdx + 3);
  return lines
    .slice(start, end + 1)
    .map((l, i) => `${start + i + 1}: ${l}`)
    .join("\n");
}
