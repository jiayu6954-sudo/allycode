import { useEffect, useState } from "react";
import type { SetupState } from "../../setup-service.js";
import { VisionPanel } from "./VisionPanel.js";

export function SetupPanel({onClose,onModel,onAccount}:{onClose:()=>void;onModel:()=>void;onAccount:()=>void}):JSX.Element {
  const [state,setState]=useState<SetupState>();const [busy,setBusy]=useState(false);const [error,setError]=useState("");
  async function refresh(){setError("");try{setState(await window.allycode.setupState());}catch(e){setError(String(e));}}
  useEffect(()=>{void refresh();},[]);
  async function install(){setBusy(true);setError("");try{setState(await window.allycode.installComponents());}catch(e){setError(String(e));}finally{setBusy(false);}}
  return <div className="modal-backdrop setup-backdrop"><section className="setup-card" role="dialog" aria-modal="true" aria-labelledby="setup-title">
    <header><h2 id="setup-title">开始设置</h2><button aria-label="关闭开始设置" onClick={onClose}>×</button></header>
    <p>按三步准备，已有设置和全部高级功能继续保留。</p>
    <h3>1. 连接模型</h3><p>AllyCode 账号与模型服务分开。选择模型并验证 API，即可执行任务。</p><button onClick={onModel}>打开模型设置</button><button onClick={onAccount}>邮箱注册／登录（可选）</button>
    <h3>2. 准备办公与识别组件</h3>
    {!state&&<p>正在检查这台电脑…</p>}
    {state?.items.map(item=><div key={item.id} className="setup-item"><strong>{item.ready?"✓":"○"} {item.title}</strong><p>{item.detail}</p></div>)}
    <p className="setup-note">安装需要联网；Linux 可能弹出系统管理员授权。仅安装所列组件，不自动运行你的业务资料。指定商业字体需使用合法授权字体。</p>
    <button className="primary" disabled={busy} onClick={()=>void install()}>{busy?"正在安装，请稍候…":"安装办公与识别组件"}</button><button disabled={busy} onClick={()=>void refresh()}>重新检测</button>
    {error&&<p role="alert" className="settings-error">{error}</p>}
    <details><summary>安装完整视觉模型（图片理解、扫描件）</summary><VisionPanel/></details>
    <h3>3. 选择项目文件夹，描述你要完成的工作</h3><p>例如：“识别这个文件夹的票据，按类别整理成 Excel，列出待核实项并保留来源。”</p>
    <footer><button onClick={onClose}>进入工作区</button></footer>
  </section></div>;
}
