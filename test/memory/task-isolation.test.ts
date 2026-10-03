import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AIProvider } from "../../src/providers/interface.js";
let root="";
beforeEach(async()=>{root=await fs.mkdtemp(path.join(os.tmpdir(),"allycode-isolation-"));vi.stubEnv("ALLYCODE_DATA_DIR",path.join(root,"data"));vi.resetModules();});
afterEach(async()=>{vi.unstubAllEnvs();vi.restoreAllMocks();await fs.rm(root,{recursive:true,force:true});});
describe("task memory boundaries",()=>{
  it("starts an isolated task and requires explicit matching task/session IDs to continue",async()=>{
    const {getAgentDatabase}=await import("../../src/storage/agent-database.js");
    const db=getAgentDatabase();
    try {
      const {DesktopAgentService}=await import("../../desktop/agent-service.js");
      const service=new DesktopAgentService(()=>null);
      vi.spyOn(service as unknown as {execute:(...args:unknown[])=>Promise<void>},"execute").mockResolvedValue();
      const first=service.start({cwd:root,prompt:"first",sessionId:"stray-session"});
      await new Promise(resolve=>setTimeout(resolve,0));
      expect(db.getTask(first.taskId)?.sessionId).toBeUndefined();
      db.attachSession(first.taskId,"owned-session");
      const second=service.start({cwd:root,prompt:"new task",sessionId:"owned-session"});
      await new Promise(resolve=>setTimeout(resolve,0));
      expect(second.taskId).not.toBe(first.taskId);
      expect(db.getTask(second.taskId)?.sessionId).toBeUndefined();
      expect(()=>service.start({cwd:root,prompt:"bad",taskId:first.taskId,sessionId:"other-session"})).toThrow(/不匹配/);
      expect(service.start({cwd:root,prompt:"follow up",taskId:first.taskId,sessionId:"owned-session"}).taskId).toBe(first.taskId);
      await new Promise(resolve=>setTimeout(resolve,0));
    }finally{db.close();}
  });
  it("keeps learned facts separate across tasks and reloads the original task",async()=>{
    const memory=await import("../../src/memory/long-term.js");
    const provider:AIProvider={providerName:"custom",stream:()=>({async *deltas(){},async finalMessage(){return {stop_reason:"end_turn",content:[{type:"text",text:JSON.stringify({user:"TASK_A_ONLY",projectContext:"TASK_A_PROJECT",projectDecisions:"",projectLearnings:""})}],usage:{input_tokens:1,output_tokens:1}};}})};
    const history=Array.from({length:4},()=>({role:"user" as const,content:"task A"}));
    await memory.extractAndSaveMemory(root,history,provider,"mock",true,"task-a");
    expect((await memory.loadLongTermMemory(root,"task-a")).user).toContain("TASK_A_ONLY");
    expect((await memory.loadLongTermMemory(root,"task-b")).user).toBe("");
    expect((await memory.loadLongTermMemory(root)).user).toBe("");
    expect((await memory.loadLongTermMemory(path.join(root,"other"),"task-a")).user).toBe("");
    vi.resetModules();
    expect((await (await import("../../src/memory/long-term.js")).loadLongTermMemory(root,"task-a")).user).toContain("TASK_A_ONLY");
  });
  it("rejects cross-project continuation",async()=>{
    const {createSession,assertSessionWorkspace}=await import("../../src/memory/session.js");
    const session=createSession(root,"mock");
    expect(()=>assertSessionWorkspace(session,root)).not.toThrow();
    expect(()=>assertSessionWorkspace(session,path.join(root,"other"))).toThrow(/其他项目/);
  });
  it("does not search another task's journal in the same project",async()=>{
    const {getAgentDatabase}=await import("../../src/storage/agent-database.js");
    const db=getAgentDatabase();
    try {
      const project=db.resolveProject(root);
      const a=db.createTask({projectId:project.id,title:"A",goal:"A"});
      const b=db.createTask({projectId:project.id,title:"B",goal:"B"});
      db.appendEvent(a.id,"note",{text:"marker A_ONLY"});db.appendEvent(b.id,"note",{text:"marker B_ONLY"});
      const {executeSessionSearch}=await import("../../src/tools/session-search.js");
      const result=await executeSessionSearch({query:"marker"},{cwd:root,taskId:a.id,timeoutMs:1000});
      expect(result.content).toContain("A_ONLY");expect(result.content).not.toContain("B_ONLY");
    }finally{db.close();}
  });
});
