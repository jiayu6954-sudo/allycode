import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { pathToFileURL } from "node:url";
import { officePath } from "./local-office.js";
import { sourcesExcelDirectory, documentsDirectory } from "../skills/bundled.js";
import { resolveWorkspacePath } from "./path-guard.js";
import { assertSafeWorkspaceRoot } from "./path-guard.js";
import { documentProcess } from "./local-document-process.js";
import type { ToolExecutionContext, ToolResult } from "../types/tools.js";

export const SourcesExcelSchema = z.object({
  action: z.enum(["status", "setup", "scan", "inspect", "attach_ocr", "build"]),
  request: z.record(z.unknown()).optional(),
});
type Python = { command: string; args: string[]; ready: boolean; version: string };

function runtimePath(ctx: ToolExecutionContext): string {
  return resolveWorkspacePath(ctx.cwd, ".allycode/tools/sources-excel/venv");
}
function runtimePython(directory: string): string {
  return path.join(directory, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
}
export async function findPython(ctx: ToolExecutionContext, modules = ["openpyxl", "pypdf"]): Promise<Python | undefined> {
  const probe = `import sys,json,importlib.util;print(json.dumps({'version':sys.version.split()[0],'supported':sys.version_info>=(3,10),'ready':all(importlib.util.find_spec(x) for x in ${JSON.stringify(modules)})}))`;
  const candidates = [{ command: runtimePython(path.join(documentsDirectory(), "venv")), args: [] }, { command: runtimePython(resolveWorkspacePath(ctx.cwd,".allycode/tools/documents/venv")), args: [] }, { command: runtimePython(runtimePath(ctx)), args: [] },
    ...(process.platform === "win32" ? [{ command: "py", args: ["-3"] }] : []),
    { command: "python3", args: [] }, { command: "python", args: [] }];
  let available: Python | undefined;
  for (const candidate of candidates) {
    ctx.signal?.throwIfAborted();
    try {
      const info = JSON.parse(await documentProcess(candidate.command, [...candidate.args, "-I", "-c", probe], ctx, undefined, 10_000)) as { supported: boolean; ready: boolean; version: string };
      if (!info.supported) continue;
      const found = { ...candidate, ready: info.ready, version: info.version };
      if (found.ready) return found;
      available ??= found;
    } catch { ctx.signal?.throwIfAborted(); }
  }
  return available;
}
export async function hashDocument(file: string): Promise<string> {
  if ((await fs.stat(file)).size > 100 * 1024 * 1024) throw new Error("文件超过 100 MiB，需分批处理。");
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}
function filePath(ctx: ToolExecutionContext, value: unknown): string {
  return resolveWorkspacePath(ctx.cwd, z.string().min(1).parse(value));
}
async function readJson(file: string): Promise<unknown> {
  if ((await fs.stat(file)).size > 32 * 1024 * 1024) throw new Error("清单超过 32 MiB，需分批处理。");
  return JSON.parse(await fs.readFile(file, "utf8"));
}
const ManifestSchema = z.object({ files: z.array(z.object({ id: z.string(), path: z.string(), sha256: z.string().optional(), status: z.string(), segments: z.array(z.record(z.unknown())) }).passthrough()) }).passthrough();

export async function executeSourcesExcel(raw: unknown, ctx: ToolExecutionContext): Promise<ToolResult> {
  assertSafeWorkspaceRoot(ctx.cwd);
  const input = SourcesExcelSchema.parse(raw);
  const directory = sourcesExcelDirectory();
  if (["status", "setup"].includes(input.action)) {
    const python = await findPython(ctx);
    if (input.action === "status") return { content: JSON.stringify({ pythonAvailable: !!python, ready: python?.ready ?? false, version: python?.version, formulaEngineReady: !!await officePath(), skillDirectory: directory, nextAction: python?.ready ? "scan" : python ? "setup" : "安装 Python 3.10+ 后重试；未自动下载 Python。", ocr: "document_ocr status 检查 Windows 本地识别能力" }), isError: false };
    if (!python) throw new Error("未找到 Python 3.10+，请安装 Python 后重试。");
    if (!python.ready) {
      const venv = runtimePath(ctx);
      await documentProcess(python.command, [...python.args, "-I", "-m", "venv", venv], ctx, undefined, 180_000);
      await documentProcess(runtimePython(venv), ["-I", "-m", "pip", "install", "--disable-pip-version-check", "-r", path.join(directory, "requirements.txt")], ctx, undefined, 300_000);
    }
    const verified = await findPython(ctx);
    if (!verified?.ready) throw new Error("依赖安装后检查失败，请查看安装结果。");
    return { content: JSON.stringify({ ready: true, version: verified.version, message: "Excel 组件检查通过，可开始扫描。" }), isError: false };
  }
  const request = { ...z.record(z.unknown()).parse(input.request) };
  if (input.action === "inspect") {
    const manifest = ManifestSchema.parse(await readJson(filePath(ctx, request.manifest)));
    const start = z.number().int().nonnegative().parse(request.start ?? 0);
    const limit = z.number().int().min(1).max(100).parse(request.limit ?? 40);
    const source = request.fileId ? manifest.files.find(file=>file.id===request.fileId) : undefined;
    if (request.fileId && !source) throw new Error("清单内不存在指定文件 ID。");
    const items = source ? source.segments : manifest.files.map(({segments,...file})=>({...file,segmentCount:segments.length}));
    return { content: JSON.stringify({ fileId: source?.id, total: items.length, start, next: start+limit<items.length ? start+limit : null, items: items.slice(start,start+limit) }), isError: false };
  }
  if (input.action === "attach_ocr") {
    const manifestPath = filePath(ctx, request.manifest);
    const manifest = ManifestSchema.parse(await readJson(manifestPath));
    const source = manifest.files.find(file => file.id === request.fileId);
    if (!source) throw new Error("清单内不存在指定文件 ID。");
    const sourcePath = filePath(ctx, source.path);
    const ocr = z.object({ source: z.string(), sha256: z.string(), method: z.enum(["windows-ocr","tesseract-ocr","paddleocr-vl"]), totalPages: z.number().int().positive(), processedPages: z.array(z.number().int().positive()).min(1), segments: z.array(z.object({ locator: z.string(), text: z.string(), page: z.number().int().positive() }).passthrough()) }).parse(await readJson(filePath(ctx, request.ocr)));
    if (ocr.processedPages.some(page=>page>ocr.totalPages)) throw new Error("OCR 页码超出原文件总页数。");
    if (filePath(ctx, ocr.source) !== sourcePath || !source.sha256 || ocr.sha256 !== source.sha256 || await hashDocument(sourcePath) !== source.sha256) throw new Error("OCR 与清单的原文件/哈希不一致，请重新扫描与识别。");
    for (const segment of ocr.segments) {
      if (!ocr.processedPages.includes(segment.page)) throw new Error("OCR 定位超出本批处理页。");
      const entry = { ...segment, method: ocr.method, reviewed: false };
      const previous = source.segments.find(item => item.locator === segment.locator);
      if (previous && previous.text !== segment.text) throw new Error("相同位置已有不同识别结果，请保留独立证据后人工核对。");
      if (!previous) source.segments.push(entry);
    }
    const oldPages = Array.isArray(source.ocrPages) ? source.ocrPages as number[] : [];
    source.ocrPages = [...new Set([...oldPages, ...ocr.processedPages])].sort((a,b)=>a-b);
    source.ocrTotalPages = ocr.totalPages;
    // Recognition is not a semantic/visual review; preserve the original status.
    const temporary = manifestPath + "." + randomUUID() + ".tmp";
    try { await fs.writeFile(temporary, JSON.stringify(manifest, null, 2), { flag: "wx" }); await fs.rename(temporary, manifestPath); }
    finally { await fs.unlink(temporary).catch(()=>{}); }
    return { content: JSON.stringify({ manifest: manifestPath, fileId: source.id, ocrPages: source.ocrPages, totalPages: ocr.totalPages, reviewed: false }), isError: false };
  }
  request.output = filePath(ctx, request.output);
  if (input.action === "scan") {
    request.inputs = z.array(z.string()).min(1).max(100).parse(request.inputs).map(p => filePath(ctx, p));
    const outputDirectory = path.dirname(String(request.output));
    if ((request.inputs as string[]).some(p => p === outputDirectory || p.startsWith(outputDirectory + path.sep))) throw new Error("请将扫描清单放在独立结果目录，例如 结果/manifest.json，不能放在输入资料的同一目录或祖先目录。");
    request.exclude = [...z.array(z.string()).parse(request.exclude ?? []).map(p => filePath(ctx, p)), resolveWorkspacePath(ctx.cwd, ".allycode"), outputDirectory];
    // Python 3.10/3.11 may traverse Windows junctions even with followlinks=False.
    // Preflight real paths and explicitly exclude reparse/symlink directories.
    const excluded = new Set(request.exclude as string[]);
    const inspect = async (directory: string): Promise<void> => {
      if (excluded.has(directory)) return;
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        ctx.signal?.throwIfAborted();
        const target = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`资料中包含符号链接或目录联接，请选择真实资料目录或排除此路径后重试：${target}`);
        if (excluded.has(target)) continue;
        filePath(ctx, target);
        if (entry.isDirectory()) await inspect(target);
      }
    };
    for (const root of request.inputs as string[]) if ((await fs.stat(root).catch(()=>undefined))?.isDirectory()) await inspect(root);
    request.exclude = [...excluded];
  } else {
    request.manifest = filePath(ctx, request.manifest);
    const manifest = ManifestSchema.parse(await readJson(String(request.manifest)));
    if ([String(request.manifest),...manifest.files.map(source=>filePath(ctx,source.path))].includes(String(request.output))) throw new Error("Excel 输出不能覆盖来源或扫描清单。");
    for (const source of manifest.files) filePath(ctx, source.path);
    const coverage = z.record(z.record(z.unknown())).parse(request.coverage);
    for (const source of manifest.files) {
      if (coverage[source.id]?.status === "included" && source.status === "needs_ocr") {
        const pages = Array.isArray(source.ocrPages) ? source.ocrPages : [];
        if (!source.ocrTotalPages || pages.length !== source.ocrTotalPages || !source.segments.length) throw new Error("图片的 OCR 页覆盖未完成，不得标记 included；补齐识别或使用 partial/unreadable 并说明遗漏。");
      }
    }
    // The Windows OCR bridge never certifies semantic accuracy. Carry its
    // unreviewed status into the deliverable instead of trusting an empty issues list.
    const sheets = z.array(z.object({ rows: z.array(z.record(z.unknown())) }).passthrough()).parse(request.sheets);
    if (manifest.files.some(source => /\.docx$/i.test(source.path) && ["included","partial"].includes(String(coverage[source.id]?.status)))) {
      // The model designs the schema from the document. Persist its rationale
      // per sheet so audit can distinguish entity rows from arbitrary text splits.
      for (const sheet of sheets) {
        if (typeof sheet.rowMeaning !== "string" || !sheet.rowMeaning.trim() || typeof sheet.designReason !== "string" || !sheet.designReason.trim()) {
          throw new Error("Word 转 Excel 须先根据全文自主设计每张表：为 sheets 填写 rowMeaning（一行代表什么）与 designReason（为何选择这些字段/拆表），无需用户填写。简单资料用一张表；复杂资料按实体、单位和明细层级拆表，不能逐段机械塞入一列。");
        }
      }
    }
    for (const sheet of sheets) for (const row of sheet.rows) {
      const evidence = z.record(z.array(z.object({ file_id: z.string(), locator: z.string() }).passthrough())).parse(row.evidence ?? {});
      const unreviewed = Object.values(evidence).flat().some(item => manifest.files.find(file=>file.id===item.file_id)?.segments.some(segment=>segment.locator===item.locator && ["windows-ocr","tesseract-ocr","paddleocr-vl","qwen-vision"].includes(String(segment.method))));
      if (unreviewed) row.issues = [...z.array(z.string()).parse(row.issues ?? []), "本地 OCR 原文未经独立视觉/人工复核，请核对编号、金额、小数点和行列关系。"];
    }
    request.sheets = sheets;
    filePath(ctx, String(request.output) + ".audit.json");
  }
  const python = await findPython(ctx);
  if (!python?.ready) throw new Error("Excel 运行组件未就绪，请先调用 status，再按权限流程执行 setup。");
  const requests = resolveWorkspacePath(ctx.cwd, ".allycode/tools/sources-excel/requests");
  await fs.mkdir(requests, { recursive: true });
  const finalOutput = String(request.output);
  const hasFormulas = input.action === "build" && z.array(z.object({columns:z.array(z.object({type:z.string().optional()}).passthrough())}).passthrough()).parse(request.sheets).some(sheet=>sheet.columns.some(column=>column.type==="formula"));
  let formulaJob: {directory:string;office:string} | undefined;
  if (hasFormulas) {
    for (const file of [finalOutput,finalOutput+".audit.json"]) if (await fs.access(file).then(()=>true,()=>false)) throw new Error("输出或审计文件已存在，请使用新的 Excel 路径。");
    const office=await officePath();
    if(!office) throw new Error("公式重算引擎缺失，请先 document_format setup 安装内置 LibreOffice；不能仅写公式就声称算对。");
    formulaJob={directory:resolveWorkspacePath(ctx.cwd,`.allycode/tools/sources-excel/formula-jobs/${randomUUID()}`),office};
    await fs.mkdir(formulaJob.directory,{recursive:true});
    request.output=path.join(formulaJob.directory,"output.xlsx");
  }
  const requestPath = path.join(requests, randomUUID() + ".json");
  try {
    await fs.writeFile(requestPath, JSON.stringify(request), { flag: "wx" });
    let result = JSON.parse(await documentProcess(python.command, [...python.args, "-I", "-X", "utf8", path.join(directory, "scripts/sources_to_excel.py"), input.action, "--request", requestPath], ctx, undefined, 300_000)) as Record<string, unknown>;
    if (result.ok !== true) throw new Error(String(result.error ?? "Excel 操作失败"));
    if (formulaJob) {
      const original=String(request.output),sha256=await hashDocument(original);
      const profile=path.join(formulaJob.directory,"profile"),calculatedDirectory=path.join(formulaJob.directory,"calculated");
      await fs.mkdir(path.join(profile,"user"),{recursive:true});await fs.mkdir(calculatedDirectory,{recursive:true});
      await fs.writeFile(path.join(profile,"user/registrymodifications.xcu"),'<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item><item oor:path="/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>0</value></prop></item></oor:items>');
      await documentProcess(formulaJob.office,[`-env:UserInstallation=${pathToFileURL(profile).href}`,"--headless","--nologo","--nodefault","--norestore","--convert-to","xlsx:Calc MS Excel 2007 XML","--outdir",calculatedDirectory,original],ctx,undefined,120000);
      result=JSON.parse(await documentProcess(python.command,[...python.args,"-I","-X","utf8",path.join(directory,"scripts/excel_formulas.py")],ctx,JSON.stringify({original,sha256,calculated:path.join(calculatedDirectory,"output.xlsx"),output:finalOutput}),120000)) as Record<string,unknown>;
      request.output=finalOutput;
    }
    if (input.action === "build") {
      const output = String(request.output), audit = output + ".audit.json";
      const artifact = { output, sha256: await hashDocument(output), audit, auditSha256: await hashDocument(audit) };
      return { content: JSON.stringify({ ...result, ...artifact, verification: "写后重开、单元格类型/值/样式与覆盖结构校验通过；语义和 OCR 仍按待核实项判断。" }), isError: false, metadata: { artifact } };
    }
    return { content: JSON.stringify(result), isError: false };
  } finally { await fs.unlink(requestPath).catch(()=>{}); }
}
