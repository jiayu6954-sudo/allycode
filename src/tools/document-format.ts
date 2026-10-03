import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { sourcesExcelDirectory, documentsDirectory } from "../skills/bundled.js";
import { resolveWorkspacePath, assertSafeWorkspaceRoot } from "./path-guard.js";
import { documentProcess } from "./local-document-process.js";
import { officePath, modernOfficeReady } from "./local-office.js";
import { findPython, hashDocument } from "./sources-to-excel.js";
import { executeDocumentVerify } from "./document-verify.js";
import { DOCUMENT_PROFILE, DocumentRequest } from "./document-profile.js";
import type { ToolExecutionContext, ToolResult } from "../types/tools.js";

const Schema = z.object({action:z.enum(["status","setup","build","title_spacing","word_to_pdf","pdf_to_word"]),request:z.record(z.unknown()).default({})});
const LO_VERSION="26.2.6";
const LO_SHA="f9877032fd908beb9c0ddf06df4af5c2e85f419c42e14876c4cce5aae5fb2660";
const LO_URL=`https://download.documentfoundation.org/libreoffice/stable/${LO_VERSION}/win/x86_64/LibreOffice_${LO_VERSION}_Win_x86-64.msi`;
const exists = (file:string)=>fs.access(file).then(()=>true,()=>false);
const json = (value:unknown):ToolResult=>({content:JSON.stringify(value),isError:false});
export async function documentFonts(ctx:ToolExecutionContext):Promise<{missing:string[];checked:boolean}> {
  const required=[DOCUMENT_PROFILE.titleFont,DOCUMENT_PROFILE.bodyFont,"楷体_GB2312","黑体","宋体","Times New Roman"];
  if(process.platform==="linux") {
    try {
      const names=(await documentProcess("fc-list",["--format=%{family}\\n"],ctx,undefined,15000)).split(/[\r\n,]+/).map(s=>s.trim());
      return {missing:required.filter(name=>!names.includes(name)),checked:true};
    } catch { return {missing:[],checked:false}; }
  }
  if(process.platform!=="win32")return {missing:[],checked:false};
  try {
    const code="[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Drawing; $c=New-Object System.Drawing.Text.InstalledFontCollection; @($c.Families | ForEach-Object { $_.Name; $_.GetName(2052); $_.GetName(1033) }) | ConvertTo-Json -Compress";
    const names=JSON.parse(await documentProcess("powershell.exe",["-NoProfile","-NonInteractive","-Command",code],ctx,undefined,15000)) as string[];
    return {missing:required.filter(name=>!names.includes(name)),checked:true};
  }catch{return {missing:[],checked:false};}
}
async function newOutput(ctx:ToolExecutionContext, value:unknown, extension:string):Promise<string> {
  const output=resolveWorkspacePath(ctx.cwd,z.string().min(1).parse(value));
  if(path.extname(output).toLowerCase()!==extension||await exists(output)||await exists(output+".audit.json"))throw new Error(`请选择新的 ${extension} 输出路径，不能覆盖已有文件。`);
  await fs.mkdir(path.dirname(output),{recursive:true});
  return output;
}
async function readRequest(ctx:ToolExecutionContext,raw:Record<string,unknown>):Promise<Record<string,unknown>> {
  if(!raw.specFile)return raw;
  const file=resolveWorkspacePath(ctx.cwd,z.string().parse(raw.specFile));
  if((await fs.stat(file)).size>2*1024*1024)throw new Error("报告内容超过 2 MiB，请拆分为多个报告。");
  return z.record(z.unknown()).parse(JSON.parse(await fs.readFile(file,"utf8")));
}
let installing:Promise<ToolResult>|undefined;
async function setup(ctx:ToolExecutionContext):Promise<ToolResult> {
  if(process.platform==="linux" && (!await findPython(ctx) || !await officePath())) {
    await documentProcess("pkexec",["/bin/sh",path.join(sourcesExcelDirectory(),"scripts/linux-components.sh")],ctx,undefined,900000);
  }
  const python=await findPython(ctx,process.platform==="linux"?["docx","pypdf","openpyxl","PIL","pypdfium2"]:["docx","pypdf","openpyxl"]);
  if(!python)throw new Error("需要先安装 Python 3.10+。");
  const directory=documentsDirectory();await fs.mkdir(directory,{recursive:true});
  if(!python.ready){
    const venv=path.join(directory,"venv");
    await documentProcess(python.command,[...python.args,"-I","-m","venv",venv],ctx,undefined,180000);
    await documentProcess(path.join(venv,process.platform==="win32"?"Scripts/python.exe":"bin/python"),["-I","-m","pip","install","--disable-pip-version-check","-r",path.join(sourcesExcelDirectory(),process.platform==="linux"?"linux-requirements.txt":"document-requirements.txt")],ctx,undefined,300000);
  }
  if(process.platform==="linux"&&!await modernOfficeReady(ctx)) await installLinuxOffice(ctx);
  if(!await officePath()){
    if(process.platform!=="win32")throw new Error("自动安装转换引擎当前支持 Windows x64。");
    const archive=path.join(directory,`downloads/LibreOffice_${LO_VERSION}_Win_x86-64.msi`);
    await fs.mkdir(path.dirname(archive),{recursive:true});
    const {hashAsset}=await import("../vision/runtime.js");
    if(!await hashAsset(archive).then(hash=>hash===LO_SHA,()=>false)){
      // A complete corrupt archive must not be resumed forever.
      if(await exists(archive))await fs.rename(archive,archive+".invalid-"+randomUUID());
      await documentProcess("curl.exe",["--silent","--show-error","--fail","--location","--proto","=https","--proto-redir","=https","--connect-timeout","30","--output",archive,LO_URL],ctx,undefined,900000);
    }
    if(await hashAsset(archive)!==LO_SHA)throw new Error("LibreOffice 官方 SHA256 校验失败，未执行解包。");
    await documentProcess("msiexec.exe",["/a",archive,"/qn",`TARGETDIR=${path.join(directory,"libreoffice")}`],ctx,undefined,300000);
    if(!await officePath())throw new Error("转换引擎解包后未找到可执行文件。");
  }
  return json({ready:true,directory,office:await officePath(),profile:DOCUMENT_PROFILE,fonts:await documentFonts(ctx)});
}
async function installLinuxOffice(ctx:ToolExecutionContext):Promise<void> {
  const directory=documentsDirectory(), archive=path.join(directory,"downloads/LibreOffice_26.2.6_Linux_x86-64_deb.tar.gz");
  const expected="fd0e8f8f2408dd2e5b90286e60f3f97cf566ba441cd48cfc5bcc68067303e0bc";
  await fs.mkdir(path.dirname(archive),{recursive:true});
  const {hashAsset}=await import("../vision/runtime.js");
  if(!await hashAsset(archive).then(hash=>hash===expected,()=>false)) {
    await documentProcess("curl",["--fail","--location","--silent","--show-error","--proto","=https","--proto-redir","=https","--connect-timeout","30","--max-time","600","--output",archive,"https://mirrors.ibiblio.org/libreoffice/stable/26.2.6/deb/x86_64/LibreOffice_26.2.6_Linux_x86-64_deb.tar.gz"],ctx,undefined,650000);
  }
  if(await hashAsset(archive)!==expected)throw new Error("Linux 转换引擎 SHA256 不匹配，未执行解包。");
  await documentProcess("python3",["-I",path.join(sourcesExcelDirectory(),"scripts/linux_office_extract.py"),archive,path.join(directory,"libreoffice")],ctx,undefined,180000);
  if(!await modernOfficeReady(ctx))throw new Error("转换引擎尚不能运行，请检查系统依赖后重新安装组件。");
}
async function build(raw:Record<string,unknown>,ctx:ToolExecutionContext,extra:Record<string,unknown>={}):Promise<ToolResult> {
  const request=DocumentRequest.parse({...raw,output:raw.output??`结果/汇报材料-${new Date().toISOString().slice(0,10)}-${randomUUID().slice(0,8)}.docx`});
  const output=await newOutput(ctx,request.output,".docx");
  const sources=await Promise.all(request.sources.map(async source=>{const file=resolveWorkspacePath(ctx.cwd,source);return {path:file,sha256:await hashDocument(file)};}));
  const python=await findPython(ctx,["docx"]);
  if(!python?.ready)throw new Error("Word 组件缺失，请先调用 document_format setup 安装内置组件。");
  const payload={...request,output,profile:DOCUMENT_PROFILE};
  await documentProcess(python.command,[...python.args,"-I","-X","utf8",path.join(sourcesExcelDirectory(),"scripts/document_build.py")],ctx,JSON.stringify(payload),120000);
  for(const source of sources)if(await hashDocument(source.path)!==source.sha256)throw new Error("生成期间来源改变，请重新核对。");
  const result=await executeDocumentVerify({path:output,sources:request.sources,expectedText:[request.title,...request.sections.slice(0,98).map(s=>s.heading)],minTables:request.sections.reduce((n,s)=>n+s.tables.length,0)},ctx);
  const fonts=await documentFonts(ctx);
  const audit={schemaVersion:1,output,sha256:await hashDocument(output),sources,profile:DOCUMENT_PROFILE,fonts,visualReview:"not_performed",...extra};
  await fs.writeFile(output+".audit.json",JSON.stringify(audit,null,2),{flag:"wx"});
  return {...result,content:JSON.stringify({...audit,audit:output+".audit.json",notice:"已按指定规则写入 Word 样式并保存当前项目。字体缺失时显示/打印可能替换；须补齐字体并渲染复核，不能据此声称格式完全一致。"})};
}

export async function executeDocumentFormat(raw:unknown,ctx:ToolExecutionContext):Promise<ToolResult> {
  assertSafeWorkspaceRoot(ctx.cwd);
  const input=Schema.parse(raw);
  if(input.action==="status")return json({python:await findPython(ctx,["docx","pypdf","openpyxl"]).then(p=>({available:!!p,ready:p?.ready??false})),office:await officePath()??null,officeReady:await modernOfficeReady(ctx),profile:DOCUMENT_PROFILE,fonts:await documentFonts(ctx),conversionScope:"Word→PDF；PDF→按页可编辑文本重建（版式、表格、图片需复核，扫描页需 OCR 证据）。"});
  if(input.action==="setup"){
    if(!installing)installing=setup(ctx).finally(()=>{installing=undefined;});
    return installing;
  }
  const request=await readRequest(ctx,input.request);
  if(input.action==="build")return build(request,ctx);
  const source=resolveWorkspacePath(ctx.cwd,z.string().min(1).parse(request.path));
  const sha256=await hashDocument(source);
  if(input.action==="title_spacing"){
    if(path.extname(source).toLowerCase()!==".docx")throw new Error("标题空行修正仅支持 .docx。");
    const output=await newOutput(ctx,request.output??source.replace(/\.docx$/i,`-标题空行修正版-${randomUUID().slice(0,8)}.docx`),".docx");
    const python=await findPython(ctx,["docx"]);if(!python?.ready)throw new Error("Word 组件缺失，请先 document_format setup。");
    const info=JSON.parse(await documentProcess(python.command,[...python.args,"-I","-X","utf8",path.join(sourcesExcelDirectory(),"scripts/document_title_spacing.py")],ctx,JSON.stringify({source,output}))) as {title:string;scope:string};
    if(await hashDocument(source)!==sha256)throw new Error("修正期间原文档改变，请重新核对。");
    const result=await executeDocumentVerify({path:output,sources:[source],expectedText:[info.title]},ctx);
    const audit={source,sourceSha256:sha256,output,sha256:await hashDocument(output),changeScope:info.scope,titleBlankLines:2,visualReview:"not_performed"};
    await fs.writeFile(output+".audit.json",JSON.stringify(audit,null,2),{flag:"wx"});
    return {...result,content:JSON.stringify({...audit,notice:"仅修正开头 Title 大标题后的空白段落并另存副本；其他 ZIP 部件原样保留。须重新渲染和校验该副本，不沿用旧 PDF 回执。"})};
  }
  if(input.action==="word_to_pdf"){
    if(path.extname(source).toLowerCase()!==".docx")throw new Error("Word 转 PDF 输入须为 .docx。");
    const office=await officePath();if(!office)throw new Error("缺少 LibreOffice，请 document_format setup 后再转换。");
    const output=await newOutput(ctx,request.output??source.replace(/\.docx$/i,".pdf"),".pdf");
    const work=resolveWorkspacePath(ctx.cwd,`.allycode/document-work/${randomUUID()}`);
    await fs.mkdir(work,{recursive:true});
    await fs.mkdir(path.join(work,"profile/user"),{recursive:true});
    await fs.writeFile(path.join(work,"profile/user/registrymodifications.xcu"),'<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item><item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>0</value></prop></item></oor:items>');
    await documentProcess(office,[`-env:UserInstallation=${pathToFileURL(path.join(work,"profile")).href}`,"--headless","--nologo","--nodefault","--norestore","--convert-to","pdf:writer_pdf_Export","--outdir",work,source],ctx,undefined,120000);
    const rendered=path.join(work,path.basename(source,path.extname(source))+".pdf");
    if(!await exists(rendered))throw new Error("转换进程结束但没有 PDF 产物；不能判为成功。");
    const python=await findPython(ctx,["pypdf"]);if(!python?.ready)throw new Error("PDF 校验组件缺失，请 document_format setup。");
    const info=JSON.parse(await documentProcess(python.command,[...python.args,"-I","-c","import sys,json;from pypdf import PdfReader;r=PdfReader(sys.argv[1]);assert len(r.pages)>0;print(json.dumps({'pages':len(r.pages)}))",rendered],ctx)) as {pages:number};
    if(await hashDocument(source)!==sha256)throw new Error("转换期间 Word 源文件改变。");
    await fs.copyFile(rendered,output,fs.constants.COPYFILE_EXCL);
    const audit={source,sourceSha256:sha256,output,sha256:await hashDocument(output),...info,fonts:await documentFonts(ctx),visualReview:"not_performed",notice:"PDF 已生成并重开验证页数。转换不证明没有字体替代、表格溢出或分页差异，请按页复核。"};
    await fs.writeFile(output+".audit.json",JSON.stringify(audit,null,2),{flag:"wx"});
    return {...json(audit),metadata:{convertedArtifact:audit}};
  }
  if(path.extname(source).toLowerCase()!==".pdf")throw new Error("PDF 转 Word 输入须为 .pdf。");
  const python=await findPython(ctx,["pypdf"]);if(!python?.ready)throw new Error("PDF 组件缺失，请 document_format setup。");
  const pages=JSON.parse(await documentProcess(python.command,[...python.args,"-I","-c","import sys,json;from pypdf import PdfReader;r=PdfReader(sys.argv[1]);assert not r.is_encrypted,'Encrypted PDF';assert 0<len(r.pages)<=100,'Split PDFs over 100 pages';print(json.dumps([{'text':p.extract_text() or '', 'images':len(p.images)} for p in r.pages],ensure_ascii=False))",source],ctx)) as Array<{text:string;images:number}>;
  const extracted=pages.map(p=>p.text);
  const ocrFiles=z.array(z.string()).max(100).parse(request.ocr??[]);
  const ocrPages=new Map<number,string>();
  for(const name of ocrFiles){
    const file=resolveWorkspacePath(ctx.cwd,name);if((await fs.stat(file)).size>32*1024*1024)throw new Error("OCR 证据过大。");
    const ocr=z.object({source:z.string(),sha256:z.string(),method:z.enum(["windows-ocr","paddleocr-vl"]),totalPages:z.number().int(),processedPages:z.array(z.number().int().positive()),segments:z.array(z.object({page:z.number().int().positive(),text:z.string()}))}).parse(JSON.parse(await fs.readFile(file,"utf8")));
    if(resolveWorkspacePath(ctx.cwd,ocr.source)!==source||ocr.sha256!==sha256||ocr.totalPages!==extracted.length||ocr.processedPages.some(p=>p>extracted.length))throw new Error("OCR 原文件、哈希或页数不匹配。");
    for(const page of ocr.processedPages){
      const text=ocr.segments.filter(s=>s.page===page).map(s=>s.text).join("\n");
      if(ocrPages.has(page)&&ocrPages.get(page)!==text)throw new Error("同页 OCR 证据冲突，需先复核。");
      if(text.trim())ocrPages.set(page,text);
    }
  }
  const missing=pages.map((page,i)=>(!page.text.trim()||(page.images>0&&page.text.trim().length<30))&&!ocrPages.has(i+1)?i+1:0).filter(Boolean);
  if(missing.length)throw new Error(`PDF 第 ${missing.join("、")} 页没有可提取文字，请用 vision_analyze paddle/text 或 document_ocr 逐页识别，再把证据 JSON 路径传入 request.ocr；不能悄悄跳过这些页。`);
  if(await hashDocument(source)!==sha256)throw new Error("提取期间 PDF 改变。");
  return build({output:request.output??source.replace(/\.pdf$/i,`-可编辑-${randomUUID().slice(0,8)}.docx`),sources:[source,...ocrFiles],title:request.title??path.basename(source,".pdf")+"可编辑文字稿",summary:"本文件按原 PDF 页码重建可编辑文本，并应用指定公文格式。原始版式、表格结构、图片、公式、签章和阅读顺序未保证还原；OCR 内容未经人工复核，请对照原 PDF 核查。",sections:extracted.map((text,i)=>({heading:`原 PDF 第 ${i+1} 页`,paragraphs:[ocrPages.get(i+1)??text]}))},ctx,{conversion:"pdf_to_editable_text",totalPages:extracted.length,ocrPages:[...ocrPages.keys()],layoutRestored:false});
}
