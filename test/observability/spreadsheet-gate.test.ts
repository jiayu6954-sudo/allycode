import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { evaluateCompletionEvidence } from "../../src/observability/completion-gate.js";
import { hashDocument } from "../../src/tools/sources-to-excel.js";
import type { TaskEventRecord } from "../../src/storage/agent-database.js";
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});});
async function fixture(){
  const cwd=await fs.mkdtemp(path.join(os.tmpdir(),"ally-artifact-gate-"));roots.push(cwd);
  const output=path.join(cwd,"result.xlsx"),audit=output+".audit.json",source=path.join(cwd,"source.txt");
  await fs.writeFile(source,"source");await fs.writeFile(output,"unit fixture: integrity only, no xlsx parsing in gate");
  await fs.writeFile(audit,JSON.stringify({manifest:{files:[{path:source,sha256:await hashDocument(source)}]},result:{unresolved_files:["F2"],review_rows:2}}));
  const artifact={output,audit,sha256:await hashDocument(output),auditSha256:await hashDocument(audit)};
  const events:TaskEventRecord[]=[
    {id:1,taskId:"t",runId:"r",createdAt:"2026-09-20T01:00:00Z",eventType:"agent_tool_start",payload:{toolId:"b",toolName:"sources_to_excel",input:{action:"build",request:{output:"result.xlsx"}}}},
    {id:2,taskId:"t",runId:"r",createdAt:"2026-09-20T01:00:01Z",eventType:"agent_tool_result",payload:{toolId:"b",toolName:"sources_to_excel",isError:false,content:"{}",metadata:{artifact}}},
  ];
  return {cwd,output,audit,source,events};
}
it("accepts native workbook verification without inventing software test obligations or data accuracy",async()=>{
  const {cwd,events}=await fixture();
  const report=await evaluateCompletionEvidence(cwd,events);
  expect(report.status).toBe("passed");
  expect(report.checks.find(c=>c.id==="spreadsheet_artifact")?.evidence).toContain("待核实记录 2");
  expect(report.checks.some(c=>c.id==="generic_verification")).toBe(false);
});
it.each(["output","audit","source"] as const)("invalidates a workbook receipt when %s changes",async key=>{
  const fixtureData=await fixture();await fs.appendFile(fixtureData[key],"changed");
  expect((await evaluateCompletionEvidence(fixtureData.cwd,fixtureData.events)).status).toBe("failed");
});
it("cannot use a workbook receipt to bypass software mutation checks",async()=>{
  const {cwd,events}=await fixture();
  const base={taskId:"t",runId:"r",createdAt:"2026-09-20T01:00:02Z"};
  events.push({...base,id:3,eventType:"agent_tool_start",payload:{toolId:"code",toolName:"file_write",input:{path:"main.ts"}}},{...base,id:4,eventType:"agent_tool_result",payload:{toolId:"code",toolName:"file_write",isError:false}});
  const report=await evaluateCompletionEvidence(cwd,events);
  expect(report.status).toBe("failed");expect(report.checks.some(c=>c.id==="spreadsheet_artifact" && c.status==="passed")).toBe(true);
});
it("does not accept a formula workbook that was written without recalculation",async()=>{
 const {cwd,events,audit}=await fixture();
 const data=JSON.parse(await fs.readFile(audit,"utf8"));data.result.formulas={count:1,status:"pending_recalculation"};
 await fs.writeFile(audit,JSON.stringify(data));
 const payload=events[1]!.payload as {metadata:{artifact:{auditSha256:string}}};payload.metadata.artifact.auditSha256=await hashDocument(audit);
 const gate=await evaluateCompletionEvidence(cwd,events);
 expect(gate.status).toBe("failed");expect(gate.checks.find(c=>c.id==="spreadsheet_artifact")?.evidence).toContain("重算");
});
