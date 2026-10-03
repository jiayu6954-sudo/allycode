import type {PlanUpdateInput} from "../../../src/types/tools.js";
export function TaskPlan({items,running}:{items:PlanUpdateInput["items"];running:boolean}):JSX.Element|null {
  if(!items.length&&!running)return null;
  const completed=items.filter(item=>item.status==="completed").length;
  return <section className="task-plan" aria-label="任务计划" aria-live="polite">
    <header><strong>{items.length ? "任务计划" : "正在制定任务计划"}</strong><span>{items.length ? `${completed} / ${items.length} 步完成` : "先规划，再执行"}</span></header>
    {items.length ? <ol>{items.map((item,index)=><li key={`${index}-${item.step}`} className={item.status}><span aria-label={item.status==="completed"?"已完成":item.status==="in_progress"?"进行中":"待开始"}>{item.status==="completed"?"✓":item.status==="in_progress"?"●":"○"}</span><span>{item.step}</span></li>)}</ol> : <p>正在整理目标、检查范围和验收步骤…</p>}
    <small>勾选表示步骤进度，最终结果仍需验收。</small>
  </section>;
}
