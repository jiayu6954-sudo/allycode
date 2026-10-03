import type { TaskEventRecord } from "../storage/agent-database.js";
import type { CompletionGateReport } from "./completion-gate.js";
import { latestDeclaredPlan } from "./delivery-receipt.js";

export interface ExecutionReceipt {
  schemaVersion: 2;
  generatedAt: string;
  taskId: string;
  runId: string;
  gate: CompletionGateReport;
  plan: ReturnType<typeof latestDeclaredPlan>;
  evidence: Array<{eventId:number;tool:string;success:boolean;evidenceId?:string}>;
  scope: string;
  stopReason?: string;
}
/** No keyword matching between unrelated tools and business requirements. */
export function buildExecutionReceipt(taskId:string,runId:string,events:TaskEventRecord[],gate:CompletionGateReport):ExecutionReceipt {
  const done = events.filter(event=>event.runId===runId && event.eventType==="agent_done").at(-1)?.payload as {stopReason?:string}|undefined;
  return {schemaVersion:2,generatedAt:new Date().toISOString(),taskId,runId,gate,plan:latestDeclaredPlan(events),stopReason:done?.stopReason,
    evidence:events.filter(event=>event.runId===runId && event.eventType==="agent_tool_result").map(event=>{
      const payload=event.payload as {toolName?:string;isError?:boolean;metadata?:{evidenceId?:string}};
      return {eventId:event.id,tool:payload.toolName??"unknown",success:payload.isError===false,evidenceId:payload.metadata?.evidenceId};
    }),scope:"这是本轮执行证据回执。计划勾选是执行者声明；工程/产物检查仅覆盖实际断言，不证明所有业务目标、OCR 数据准确性、真实部署或跨设备使用已完成。"};
}
export function renderExecutionReceipt(receipt:ExecutionReceipt):string {
  const completed=receipt.plan.filter(item=>item.status==="completed").length;
  const paused = receipt.stopReason === "max_iterations" || receipt.stopReason === "tool_budget" || receipt.stopReason === "checkpoint";
  return [paused ? "## 系统阶段回执" : "## 系统验收回执",
    ...(paused ? [receipt.stopReason === "max_iterations" ? "任务状态：达到本轮执行上限，已保存进度；这不是最终交付结论，可在本任务继续。" : "任务状态：已在阶段检查点暂停，尚未宣告全部交付。"] : []),
    `执行检查：${receipt.gate.status==="passed"?"通过":receipt.gate.status==="failed"?"未通过":"不适用"}`,
    ...receipt.gate.checks.map(check=>`- ${check.label}：${check.status==="passed"?"通过":check.status==="failed"?"未通过":"不适用"}。${check.evidence}`),
    `计划进度：${completed}/${receipt.plan.length}；${receipt.plan.length-completed} 项尚未完成。`,
    `本轮工具结果：${receipt.evidence.filter(item=>item.success).length} 次成功，${receipt.evidence.filter(item=>!item.success).length} 次失败。`,
    receipt.scope,`回执已自动保存到任务记录，无需为保存回执额外修改文件或重跑；未完成事项和失败检查仍需继续处理。\n任务 ${receipt.taskId} · 运行 ${receipt.runId} · ${receipt.generatedAt}`].join("\n\n");
}
