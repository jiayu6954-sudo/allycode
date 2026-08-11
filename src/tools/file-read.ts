import fs from "node:fs/promises";
import type { FileReadInput, ToolResult, ToolExecutionContext } from "../types/tools.js";
import { logger } from "../utils/logger.js";
import { resolveWorkspacePath } from "./path-guard.js";

const MAX_BYTES = 200_000;
const MAX_LINES_WITHOUT_RANGE = 2000;

export async function executeFileRead(
  input: FileReadInput,
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  const filePath = resolveWorkspacePath(ctx.cwd, input.path);
  logger.debug("file_read.execute", { path: filePath, startLine: input.startLine, endLine: input.endLine });

  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      return { content: `Error: '${input.path}' is a directory, not a file.`, isError: true };
    }

    const bytesToRead = Math.min(stat.size, MAX_BYTES);
    const buffer = Buffer.alloc(bytesToRead);
    const handle = await fs.open(filePath, "r");
    try {
      await handle.read(buffer, 0, bytesToRead, 0);
    } finally {
      await handle.close();
    }
    const rawContent = buffer.toString("utf-8");
    const lines = rawContent.split("\n");
    const totalLines = lines.length;

    let startLine = input.startLine ?? 1;
    let endLine = input.endLine ?? totalLines;

    // Clamp to valid range
    startLine = Math.max(1, startLine);
    endLine = Math.min(totalLines, endLine);

    // Auto-limit if no range given and file is large
    if (!input.startLine && !input.endLine && totalLines > MAX_LINES_WITHOUT_RANGE) {
      endLine = MAX_LINES_WITHOUT_RANGE;
    }

    const selectedLines = lines.slice(startLine - 1, endLine);

    // Format with line numbers (cat -n style)
    const numbered = selectedLines
      .map((line, i) => `${String(startLine + i).padStart(6)}\t${line}`)
      .join("\n");

    const truncated = endLine < totalLines || stat.size > MAX_BYTES;
    const suffix = truncated
      ? `\n\n[Output truncated. Showing lines ${startLine}-${endLine}; use a narrower line range to read more.]`
      : "";

    const bytesRead = Buffer.byteLength(numbered, "utf-8");

    return {
      content: numbered + suffix,
      isError: false,
      metadata: { truncated, bytesRead },
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { content: `Error: File not found: ${input.path}`, isError: true };
    }
    if ((err as NodeJS.ErrnoException).code === "EACCES") {
      return { content: `Error: Permission denied: ${input.path}`, isError: true };
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("file_read.error", err);
    return { content: `file_read error: ${msg}`, isError: true };
  }
}
