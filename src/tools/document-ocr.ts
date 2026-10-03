import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { sourcesExcelDirectory } from "../skills/bundled.js";
import { resolveWorkspacePath } from "./path-guard.js";
import { documentProcess } from "./local-document-process.js";
import { findPython, hashDocument } from "./sources-to-excel.js";
import type { ToolExecutionContext, ToolResult } from "../types/tools.js";

export const DocumentOcrSchema = z.object({
  action: z.enum(["status", "recognize"]), path: z.string().min(1).optional(), output: z.string().min(1).optional(),
  language: z.string().regex(/^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{2,8})*$/).optional(),
  startPage: z.number().int().min(1).default(1), endPage: z.number().int().min(1).optional(),
});

export async function executeDocumentOcr(raw: unknown, ctx: ToolExecutionContext): Promise<ToolResult> {
  const input = DocumentOcrSchema.parse(raw);
  if (!["win32","linux"].includes(process.platform)) return { content: JSON.stringify({ available: false, reason: "此平台尚未适配内置 OCR。" }), isError: input.action !== "status" };
  const script = path.join(sourcesExcelDirectory(), "scripts/windows_ocr.ps1");
  let source: string | undefined, output: string | undefined, sha256: string | undefined;
  if (input.action === "recognize") {
    source = resolveWorkspacePath(ctx.cwd, z.string().min(1).parse(input.path));
    output = resolveWorkspacePath(ctx.cwd, z.string().min(1).parse(input.output));
    if (!/\.(pdf|png|jpe?g|bmp|tiff?)$/i.test(source)) throw new Error("OCR 支持 PDF、PNG、JPEG、BMP、TIFF；其他格式请显式转换副本。");
    if (!/\.json$/i.test(output) || source === output) throw new Error("OCR 输出必须是新的 JSON 证据文件。");
    if (await fs.stat(output).then(()=>true,()=>false)) throw new Error("OCR 输出已存在，请使用新文件名。");
    if ((input.endPage ?? input.startPage + 9) < input.startPage || (input.endPage ?? input.startPage + 9) - input.startPage >= 10) throw new Error("每次最多识别 10 页，请分批处理并累计覆盖。");
    sha256 = await hashDocument(source);
  }
  const executable = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
  let content:string;
  const payload=JSON.stringify({ ...input, path: source, endPage: input.endPage ?? input.startPage + 9 });
  if(process.platform==="linux") {
    const python=await findPython(ctx,["PIL","pypdfium2"]);
    if(!python?.ready) {
      if(input.action==="status")return {content:JSON.stringify({available:false,reason:"请在开始设置中安装办公与识别组件。"}),isError:false};
      throw new Error("Linux OCR 组件缺失，请在开始设置中安装办公与识别组件。");
    }
    content=await documentProcess(python.command,[...python.args,"-I",path.join(sourcesExcelDirectory(),"scripts/linux_vision.py")],ctx,payload,180000);
  } else content=await documentProcess(executable,["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],ctx,payload,180000);
  const result = JSON.parse(content) as Record<string, unknown>;
  if (source && output) {
    if (await hashDocument(source) !== sha256) throw new Error("识别期间原文件改变，未保存失配的 OCR 证据。");
    const evidence = { ...result, source, sha256, reviewed: false };
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify(evidence, null, 2), { flag: "wx" });
    return { content: JSON.stringify({ ...evidence, output }), isError: false };
  }
  return { content: JSON.stringify(result), isError: false };
}
