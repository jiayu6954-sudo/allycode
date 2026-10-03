import { execa } from "execa";
import type { ToolExecutionContext } from "../types/tools.js";

/** Fixed executables and argument arrays only; request data never becomes shell code. */
export async function documentProcess(command: string, args: string[], ctx: ToolExecutionContext, input?: string, timeout = 120_000): Promise<string> {
  const result = await execa(command, args, {
    cwd: ctx.cwd, windowsHide: true, shell: false, reject: false,
    timeout, cancelSignal: ctx.signal, maxBuffer: 8 * 1024 * 1024,
    input, encoding: "utf8", env: { PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
  });
  // shortMessage contains the whole Python -c program: do not echo helper code into model context.
  if (result.exitCode !== 0) throw new Error([result.stderr, result.stdout, `本地文档工具退出码：${result.exitCode ?? "未知"}`].filter(Boolean).join("\n").slice(0, 4000));
  return result.stdout;
}
