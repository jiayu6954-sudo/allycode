import type { PermissionDecision, PermissionRequest } from "../../../src/types/permissions.js";
import { presentPermission } from "./permission-presentation.js";

export function PermissionCard({request,cwd,onDecision}:{request:PermissionRequest;cwd:string;onDecision:(decision:PermissionDecision)=>Promise<void>}):JSX.Element {
  const content=presentPermission(request,cwd);
  const dangerous=request.riskLevel==="dangerous";
  return <div className="modal-backdrop"><section className="permission-card" role="dialog" aria-modal="true" aria-labelledby="permission-title">
    <span className={`risk ${request.riskLevel}`}>{dangerous?"高风险 · 仅单次确认":request.riskLevel==="moderate"?"等待你的确认":"低风险 · 等待确认"}</span>
    <h2 id="permission-title">{content.title}</h2>
    <p className="permission-purpose">{content.purpose}</p>
    <dl className="permission-facts"><div><dt>操作对象</dt><dd>{content.target}</dd></div><div><dt>影响范围</dt><dd>{content.effect}</dd></div></dl>
    <details className="permission-details"><summary>查看操作详情（命令 / 参数）</summary><pre>{JSON.stringify(request.input,null,2)}</pre></details>
    <div className="permission-choices">
      <button autoFocus onClick={()=>void onDecision("allow")}><strong>1 · 仅允许这一次</strong><span>执行上面说明的操作</span></button>
      {!dangerous && <button onClick={()=>void onDecision("allow-session")}><strong>2 · 本任务允许同类操作</strong><span>{content.taskAllowance}</span></button>}
      <button onClick={()=>void onDecision("deny")}><strong>{dangerous?"2":"3"} · 拒绝此次操作</strong><span>不执行本次操作；可再补充要求</span></button>
    </div>
  </section></div>;
}
