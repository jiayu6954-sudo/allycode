import { useEffect, useState } from "react";
import type { WorkbenchAction, WorkbenchResult } from "../../shared.js";

export function WorkbenchPanel({cwd, running, onClose}:{cwd:string;running:boolean;onClose:()=>void}): JSX.Element {
  const [result,setResult]=useState<WorkbenchResult>({message:"正在检查本地环境…"});
  const [snapshots,setSnapshots]=useState<NonNullable<WorkbenchResult["snapshots"]>>([]);
  const [busy,setBusy]=useState(false);
  async function run(action: WorkbenchAction, id?:string):Promise<void> {
    setBusy(true);
    try {
      const next=await window.allycode.workbenchAction(action,cwd,id);
      setResult(next);
      if(next.snapshots)setSnapshots(next.snapshots);
      if(action === "snapshot" || action === "restore")setSnapshots((await window.allycode.workbenchAction("inspect",cwd)).snapshots ?? []);
    } catch(error) {setResult({message:String(error)});} finally {setBusy(false);}
  }
  useEffect(()=>{void run("inspect");},[cwd]);
  return <div className="modal-backdrop"><section className="engine-card workbench-card">
    <header><div><h2>工作台与能力安装</h2><p>检查环境、保存版本、打开成果，再按需要添加能力。</p></div><button aria-label="关闭工作台" onClick={onClose}>×</button></header>
    <div className="workbench-actions">
      <button disabled={busy} onClick={()=>void run("inspect")}>检查本地环境</button>
      <button disabled={busy || !cwd} onClick={()=>void run("open-project")}>打开成果目录</button>
      <button disabled={busy || running || !cwd} onClick={()=>void run("snapshot")}>保存当前版本</button>
    </div>
    <h3>添加能力</h3>
    <p>已内置：文件与命令、网络搜索与读取、网页点击与填写、Windows 软件窗口检查与操作。电脑操作会按动作申请授权。</p>
    <p>原生引擎已内置。工作流和工具连接可按需导入，外部引擎单独安装与登录。</p>
    <div className="workbench-actions">
      <button disabled={busy || running} onClick={()=>void run("import-skill")}>导入工作流 .md</button>
      <button disabled={busy || running} onClick={()=>void run("import-mcp")}>导入工具连接 .json</button>
      <button disabled={busy || running} onClick={()=>void run("install-codex")}>安装 Codex 引擎</button>
    </div>
    <pre role="status" className="workbench-status">{busy ? "正在处理，请稍候…" : result.message}</pre>
    <h3>已保存的版本</h3>
    <p>恢复前会自动备份当前文件。依赖、构建输出和临时目录不在快照范围。</p>
    <div className="workbench-snapshots">{snapshots.length ? snapshots.slice(0,12).map((snapshot)=><div key={snapshot.id}><span>{snapshot.label}<small>{new Date(snapshot.createdAt).toLocaleString()}</small></span><button disabled={busy || running} onClick={()=>void run("restore",snapshot.id)}>恢复</button></div>):<p>暂无版本，开始工作前可先保存。</p>}</div>
  </section></div>;
}
