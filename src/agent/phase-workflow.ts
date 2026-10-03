import { z } from "zod";
import type { TaskEventRecord } from "../storage/agent-database.js";

/** Explicit public checkpoint, never provider reasoning or an implicit approval. */
export const PhaseCheckpointSchema = z.object({
  kind: z.enum(["decision", "handoff"]),
  title: z.string().min(1).max(160),
  summary: z.string().min(1).max(6000),
  document: z.string().min(1).max(500),
  nextSteps: z.array(z.string().min(1).max(500)).min(1).max(12),
  options: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,24}$/), title: z.string().min(1).max(160), tradeoff: z.string().min(1).max(1000) })).max(3).default([]),
}).superRefine((value, ctx) => {
  if (value.kind === "decision" && value.options.length < 2) ctx.addIssue({code:"custom",message:"方案选择至少需要两个有实际取舍的选项"});
  if (new Set(value.options.map(item=>item.id)).size !== value.options.length) ctx.addIssue({code:"custom",message:"方案 ID 不能重复"});
});
export type PhaseCheckpoint = z.infer<typeof PhaseCheckpointSchema>;
export function latestPhaseCheckpoint(events:TaskEventRecord[]):{id:number;toolId:string;phase:PhaseCheckpoint}|undefined {
  const starts=new Map<string,{id:number;toolId:string;phase:PhaseCheckpoint}>();
  let latest:ReturnType<typeof latestPhaseCheckpoint>;
  for(const event of events){
    const p=event.payload as {toolId?:string;toolName?:string;input?:unknown;isError?:boolean};
    const key=`${event.runId}:${p.toolId}`;
    if(event.eventType==="agent_tool_start"&&p.toolName==="phase_checkpoint"){
      const parsed=PhaseCheckpointSchema.safeParse(p.input);
      if(parsed.success&&p.toolId) starts.set(key,{id:event.id,toolId:p.toolId,phase:parsed.data});
    }
    if(event.eventType==="agent_tool_result"&&p.isError===false&&starts.has(key)) latest=starts.get(key);
  }
  return latest;
}
export function selectedPhaseOption(phase:PhaseCheckpoint,prompt:string):string|undefined {
  const text=prompt.trim();
  return phase.options.find(option=>[option.id,`选择方案 ${option.id}`,`选择方案${option.id}`,`我选择方案 ${option.id}`,`我选择方案${option.id}`].includes(text))?.id;
}
export function renderPhaseCheckpoint(phase: PhaseCheckpoint): string {
  return [`## ${phase.kind === "decision" ? "请选择方案" : "阶段交接"}：${phase.title}`,phase.summary,`架构/交接文档：${phase.document}`,
    ...phase.options.map(option=>`- ${option.id} · ${option.title}：${option.tradeoff}`),
    "下一阶段：",...phase.nextSteps.map(step=>`- [ ] ${step}`),
    phase.kind === "decision" ? "请回复方案编号，或补充需要调整的约束。收到明确选择后才进入实施。" : "本阶段已保存。可以在当前任务继续，也可以用阶段交接记录开启独立的下一阶段任务。",
  ].join("\n\n");
}
