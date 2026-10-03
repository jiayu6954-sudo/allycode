import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, it, expect } from "vitest";
import { executeDocumentVerify } from "../../src/tools/document-verify.js";
import { documentProcess } from "../../src/tools/local-document-process.js";
import { evaluateCompletionEvidence } from "../../src/observability/completion-gate.js";
import type { TaskEventRecord } from "../../src/storage/agent-database.js";
import type { ToolResult } from "../../src/types/tools.js";
import { DOCUMENT_PROFILE } from "../../src/tools/document-profile.js";
import { sourcesExcelDirectory } from "../../src/skills/bundled.js";
import { findPython } from "../../src/tools/sources-to-excel.js";
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});});
async function fixture() {
  const cwd=await fs.mkdtemp(path.join(os.tmpdir(),"ally-word-"));roots.push(cwd);
  await fs.writeFile(path.join(cwd,"source.csv"),"count\n14428\n");
  const ctx={cwd,timeoutMs:30000};
  const python=await findPython(ctx,["docx"]);if(!python?.ready)throw new Error("Test prerequisite: python-docx");
  await documentProcess(python.command,[...python.args,"-I","-X","utf8",path.join(sourcesExcelDirectory(),"scripts/document_build.py")],ctx,JSON.stringify({output:path.join(cwd,"report.docx"),title:"中文汇总",summary:"全量记录 14428",sections:[{heading:"统计",paragraphs:[],tables:[{headers:["行数"],rows:[["14428"]]}]}],profile:DOCUMENT_PROFILE}));
  const input={path:"report.docx",sources:["source.csv"],expectedText:["中文汇总","14428"],minTables:1};
  return {cwd,input,ctx:{cwd,timeoutMs:30000}};
}
function events(input:unknown,result:ToolResult):TaskEventRecord[]{
  const base={taskId:"t",runId:"r",createdAt:"now"};
  return [
    {...base,id:1,eventType:"agent_tool_start",payload:{toolId:"build",toolName:"bash",input:{command:"python report.py"}}},
    {...base,id:2,eventType:"agent_tool_result",payload:{toolId:"build",toolName:"bash",isError:false}},
    {...base,id:3,eventType:"agent_tool_start",payload:{toolId:"verify",toolName:"document_verify",input}},
    {...base,id:4,eventType:"agent_tool_result",payload:{toolId:"verify",toolName:"document_verify",...result}},
  ];
}
it("verifies actual Word XML and permits plan closure without software tests",async()=>{
  const {cwd,input,ctx}=await fixture();
  const result=await executeDocumentVerify(input,ctx);
  expect(result.metadata?.documentArtifact?.verification).toMatchObject({tables:1,assertions:2,visualReview:"not_performed"});
  const log=events(input,result);
  log.push({id:5,taskId:"t",runId:"r",createdAt:"now",eventType:"agent_tool_start",payload:{toolId:"plan",toolName:"plan_update",input:{}}});
  expect((await evaluateCompletionEvidence(cwd,log)).status).toBe("passed");
});
it.each(["missing","text","tables","corrupt","outside","format","inline","title_spacing"])("rejects invalid report evidence: %s",async kind=>{
  const {cwd,input,ctx}=await fixture();
  if(kind==="missing")input.path="missing.docx";
  if(kind==="text")input.expectedText=["wrong number 99999"];
  if(kind==="tables")input.minTables=2;
  if(kind==="corrupt")await fs.writeFile(path.join(cwd,"report.docx"),"not a ZIP");
  if(kind==="outside")input.sources=["../outside.csv"];
  if(kind==="format"||kind==="inline"||kind==="title_spacing"){
    const python=await findPython(ctx,["docx"]);if(!python)throw new Error("Python missing");
    const mutation=kind==="format"?"d.styles['Normal'].font.size=Pt(10)":kind==="inline"?"d.paragraphs[0].runs[0].font.size=Pt(10)":"d.paragraphs[1]._element.getparent().remove(d.paragraphs[1]._element)";
    await documentProcess(python.command,[...python.args,"-I","-c",`from docx import Document;from docx.shared import Pt;d=Document('report.docx');${mutation};d.save('report.docx')`],ctx);
  }
  await expect(executeDocumentVerify(input,ctx)).rejects.toThrow();
});
it.each(["report","source","later_mutation","package","failed_retry","other_run"])("does not accept stale or inapplicable document evidence: %s",async kind=>{
  const {cwd,input,ctx}=await fixture();
  const result=await executeDocumentVerify(input,ctx); const log=events(input,result);
  if(kind==="report")await fs.appendFile(path.join(cwd,"report.docx"),"changed");
  if(kind==="source")await fs.appendFile(path.join(cwd,"source.csv"),"changed");
  if(kind==="package")await fs.writeFile(path.join(cwd,"package.json"),JSON.stringify({scripts:{test:"vitest run"}}));
  if(kind==="later_mutation")log.push(...events({},result).slice(0,2).map(e=>({...e,id:e.id+5,payload:{...(e.payload as object),toolId:"later"}})));
  if(kind==="failed_retry")log.push(...events(input,{content:"failed",isError:true}).slice(2).map(e=>({...e,id:e.id+5,payload:{...(e.payload as object),toolId:"retry"}})));
  if(kind==="other_run")log.push({id:5,taskId:"t",runId:"new",createdAt:"now",eventType:"agent_tool_start",payload:{toolId:"new",toolName:"plan_update",input:{}}});
  expect((await evaluateCompletionEvidence(cwd,log)).status).toBe("failed");
});

it("coalesces relative/absolute retry paths, reports failed attempts, and verifies explicit deliveries",async()=>{
  const {cwd,input,ctx}=await fixture();
  const finalInput={...input,deliveryFiles:["report.docx"]};
  const result=await executeDocumentVerify(finalInput,ctx);
  const base={taskId:"t",runId:"r",createdAt:"now"};
  const log:TaskEventRecord[]=[];
  const append=(name:string,call:unknown,value:ToolResult)=>{
    const id=log.length+1,toolId=String(id);
    log.push({...base,id,eventType:"agent_tool_start",payload:{toolId,toolName:name,input:call}}, {...base,id:id+1,eventType:"agent_tool_result",payload:{toolId,toolName:name,...value}});
  };
  append("document_format",{action:"build",request:{specFile:"invalid.json"}},{isError:true,content:"invalid request"});
  append("document_verify",{...input,path:"deleted-probe.docx"},{isError:true,content:"missing probe"});
  append("document_verify",input,{isError:true,content:"old failed relative attempt"});
  append("document_verify",finalInput,result);
  const gate=await evaluateCompletionEvidence(cwd,log);
  expect(gate.status).toBe("passed");
  expect(gate.checks.filter(c=>c.id==="word_artifact")).toHaveLength(1);
  expect(gate.checks.find(c=>c.id==="document_scope")?.evidence).toContain("deleted-probe.docx");
  // A later failed verification of the same file must still invalidate success.
  append("document_verify",input,{isError:true,content:"new failure"});
  expect((await evaluateCompletionEvidence(cwd,log)).status).toBe("failed");
});

it("cannot declare missing deliveries passed or hide corrupt/unverified files behind a manifest",async()=>{
  const {cwd,input,ctx}=await fixture();
  const finalInput={...input,deliveryFiles:["report.docx","missing.docx"]};
  const result=await executeDocumentVerify(finalInput,ctx);
  expect((await evaluateCompletionEvidence(cwd,events(finalInput,result))).status).toBe("failed");
  await expect(executeDocumentVerify({...input,deliveryFiles:["../other.docx"]},ctx)).rejects.toThrow();
  await expect(executeDocumentVerify({...input,deliveryFiles:["unrelated.docx"]},ctx)).rejects.toThrow();
});
