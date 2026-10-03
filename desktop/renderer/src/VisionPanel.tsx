import { useEffect, useState } from "react";
import type { VisionState } from "../../../src/vision/runtime.js";

export function VisionPanel():JSX.Element {
  const [state,setState]=useState<VisionState>();
  const [error,setError]=useState("");
  const [installing,setInstalling]=useState(false);
  useEffect(()=>{let live=true;const refresh=()=>{void window.allycode.visionStatus().then(value=>{if(live)setState(value);}).catch(reason=>{if(live)setError(String(reason));});};refresh();const timer=setInterval(refresh,2000);return()=>{live=false;clearInterval(timer);};},[]);
  async function install():Promise<void>{setError("");setInstalling(true);try{setState(await window.allycode.visionInstall());}catch(reason){setError(String(reason));}finally{setInstalling(false);}}
  const busy=installing||state?.phase==="downloading";
  return <section className="vision-panel" aria-label="本地视觉组件">
    <h3>本地视觉</h3>
    <p>Qwen3.5-9B 理解图片与截图；PaddleOCR-VL-1.6 提取文档内容。无需视觉 API 密钥。</p>
    <p>{state?.message??"正在检查组件…"}</p>
    {state&&<><p style={{overflowWrap:"anywhere"}}>保存位置：{state.directory}</p><progress style={{width:"100%"}} value={state.downloadedBytes} max={state.totalBytes}/><p>{(state.downloadedBytes/1e9).toFixed(2)} / {(state.totalBytes/1e9).toFixed(2)} GB · {state.ready?"组件已安装，分析时按需加载":`首次安装需下载模型，并预留约 ${window.allycode.platform==="linux"?10:5}GB 解压空间`}</p></>}
    <button type="button" disabled={busy||state?.busy} onClick={()=>void install()}>{state?.ready?"校验／修复组件":"下载／继续安装视觉组件"}</button>
    {busy&&<button type="button" onClick={()=>void window.allycode.visionCancel().catch(reason=>setError(String(reason)))}>暂停下载</button>}
    <p>使用输入框旁的“＋ 图片/PDF”添加资料，再说明需求即可。识别结果需要核对；使用云端主模型时，提取内容可能进入其上下文。</p>
    {error&&<p role="alert">{error}</p>}
  </section>;
}
