import fs from "node:fs/promises";
import path from "node:path";
import { isBrowserAvailable } from "../src/tools/browser.js";
import { DATA_DIR } from "../src/config/settings.js";
import { documentsDirectory, sourcesExcelDirectory } from "../src/skills/bundled.js";
import { executeDocumentFormat } from "../src/tools/document-format.js";
import { executeDocumentOcr } from "../src/tools/document-ocr.js";
import { documentProcess } from "../src/tools/local-document-process.js";
import { getVisionRuntime } from "../src/vision/runtime.js";

export interface SetupItem { id: string; title: string; ready: boolean; detail: string }
export interface SetupState { platform: string; items: SetupItem[]; installing: boolean }
let installation: Promise<SetupState> | undefined;
async function context() {const cwd=path.join(DATA_DIR,"setup"); await fs.mkdir(cwd,{recursive:true}); return {cwd,timeoutMs:900000};}
export async function setupState(): Promise<SetupState> {
  const ctx=await context();
  const items:SetupItem[]=[];
  try {
    const result=JSON.parse((await executeDocumentFormat({action:"status"},ctx)).content);
    items.push({id:"documents",title:"Word、PDF 与 Excel 计算",ready:result.python.ready&&result.officeReady===true,detail:result.python.ready&&result.officeReady?"文档组件与转换引擎已就绪":"点击安装组件，自动检查 Python、文档库和转换引擎。"});
    items.push({id:"fonts",title:"公文指定字体",ready:result.fonts.checked&&result.fonts.missing.length===0,detail:result.fonts.checked?(result.fonts.missing.length?"缺少："+result.fonts.missing.join("、")+"。文档仍可生成，但显示和打印可能替换字体。":"指定字体已找到。") :"尚不能确认字体；请打开生成文件核对。"});
  }catch{items.push({id:"documents",title:"办公组件",ready:false,detail:"组件检查失败，请安装后重新检测。"});}
  try {const value=JSON.parse((await executeDocumentOcr({action:"status"},ctx)).content);items.push({id:"ocr",title:"本地文字识别",ready:value.available===true,detail:value.reason??"识别结果仍需核对金额、编号和页覆盖。"});}
  catch{items.push({id:"ocr",title:"本地文字识别",ready:false,detail:"请安装办公与识别组件。"});}
  items.push({id:"browser",title:"真实浏览器验证",ready:isBrowserAvailable(),detail:isBrowserAvailable()?"浏览器已找到；页面仍需逐项实际验收。":"Linux 可通过安装组件获取独立 Chromium；Windows 请安装 Edge 或 Chrome。"});
  const vision=await getVisionRuntime().status();
  items.push({id:"vision",title:"完整视觉理解",ready:vision.ready,detail:vision.ready?"Qwen 和 Paddle 已安装；首次分析需要加载模型。":"可另行安装 Qwen 与 Paddle，下载约 10 GB；文字办公无需等待模型下载。"});
  return {platform:process.platform,items,installing:!!installation};
}
export function installComponents():Promise<SetupState> {
  if(installation)return installation;
  installation=(async()=>{
    const ctx=await context();
    if(process.platform==="linux") await documentProcess("pkexec",["/bin/sh",path.join(sourcesExcelDirectory(),"scripts/linux-components.sh")],ctx,undefined,900000);
    await executeDocumentFormat({action:"setup"},ctx);
    if(process.platform==="linux") {
      const venv=path.join(documentsDirectory(),"venv");
      await documentProcess("python3",["-I","-m","venv",venv],ctx,undefined,180000);
      await documentProcess(path.join(venv,"bin/python"),["-I","-m","pip","install","--disable-pip-version-check","-r",path.join(sourcesExcelDirectory(),"linux-requirements.txt")],ctx,undefined,300000);
    }
    if(process.platform==="linux"&&!isBrowserAvailable()) await documentProcess(path.join(documentsDirectory(),"venv/bin/python"),["-I",path.join(sourcesExcelDirectory(),"scripts/linux_browser_install.py"),path.join(DATA_DIR,"components/browser")],ctx,undefined,900000);
    return {...await setupState(),installing:false};
  })().finally(()=>{installation=undefined;});
  return installation;
}
