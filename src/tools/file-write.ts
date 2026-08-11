import fs from "node:fs/promises";
import path from "node:path";
import type { FileWriteInput, ToolResult, ToolExecutionContext } from "../types/tools.js";
import { logger } from "../utils/logger.js";
import { resolveWorkspacePath } from "./path-guard.js";

export async function executeFileWrite(
  input: FileWriteInput,
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  const filePath = resolveWorkspacePath(ctx.cwd, input.path);
  logger.debug("file_write.execute", { path: filePath, bytes: Buffer.byteLength(input.content) });

  try {
    // Create parent directories if they don't exist
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    // Check if file existed before (for reporting)
    let existed = false;
    try {
      await fs.access(filePath);
      existed = true;
    } catch {
      // File doesn't exist — that's fine
    }

    await fs.writeFile(filePath, input.content, "utf-8");

    const lines = input.content.split("\n").length;
    const bytes = Buffer.byteLength(input.content, "utf-8");

    return {
      content: `${existed ? "Updated" : "Created"} ${input.path} (${lines} lines, ${bytes} bytes)`,
      isError: false,
      metadata: { bytesRead: bytes },
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EACCES") {
      return { content: `Error: Permission denied writing to: ${input.path}`, isError: true };
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("file_write.error", err);
    return { content: `file_write error: ${msg}`, isError: true };
  }
}
