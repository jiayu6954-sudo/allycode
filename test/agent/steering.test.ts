import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SteeringQueue, recoverSteering } from "../../src/agent/steering.js";
import { runAgentLoop } from "../../src/agent/loop.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PermissionManager } from "../../src/permissions/manager.js";
import { SettingsSchema } from "../../src/config/schema.js";
import type { AIProvider, NormalizedMessage, StreamParams } from "../../src/providers/interface.js";
import type { AgentEvent, AgentLoopOptions, ConversationMessage } from "../../src/types/agent.js";

const supplement = {id:"steer-1",text:"先停止写文件，改为仅检查需求。",createdAt:"2026-09-16T00:00:00Z"};
const done: NormalizedMessage = {stop_reason:"end_turn",content:[{type:"text",text:"已按新要求完成检查。"}],usage:{input_tokens:1,output_tokens:1}};
const tool = (id:string,name:string,input:unknown): NormalizedMessage => ({stop_reason:"tool_use",content:[{type:"tool_use",id,name,input}],usage:{input_tokens:1,output_tokens:1}});
const plan = tool("plan","plan_update",{items:[{step:"检查并验收",status:"in_progress"}]});
const closedPlan = tool("plan-closed","plan_update",{items:[{step:"检查并验收",status:"completed"}]});

describe("live steering and visible planning",()=>{
  let cwd:string;
  afterEach(async()=>{if(cwd)await fs.rm(cwd,{recursive:true,force:true});});
  async function run(responses:NormalizedMessage[], overrides:Partial<AgentLoopOptions>={}, onRequest?:(params:StreamParams,index:number)=>void){
    cwd=await fs.mkdtemp(path.join(os.tmpdir(),"allycode-steering-"));
    let index=0;
    const events:AgentEvent[]=[];
    const requests:StreamParams[]=[];
    const provider={stream(params:StreamParams){
      requests.push(structuredClone({...params,signal:undefined}));
      onRequest?.(params,index);
      const message=responses[index++];
      if(!message)throw new Error("Unscripted model request");
      return {async *deltas(){yield {type:"text" as const,text:"处理中"};},async finalMessage(){return message;}};
    }} as AIProvider;
    const result=await runAgentLoop(provider,{model:"mock",maxTokens:200,systemPrompt:"测试",conversationHistory:[{role:"user",content:"开始"}],onEvent:event=>events.push(event),...overrides},new ToolRegistry(cwd),new PermissionManager(SettingsSchema.parse({defaultPermissions:{file_write:"auto",plan_update:"auto"}}),async()=>"allow",false));
    return {result,events,requests};
  }

  it("queues independently, validates input and recovers only unapplied messages",()=>{
    const a=new SteeringQueue(),b=new SteeringQueue();
    a.enqueue(supplement);a.enqueue(supplement);
    expect(a.peek()).toHaveLength(1);expect(b.peek()).toEqual([]);
    a.peek()[0]!.text="mutation";expect(a.peek()[0]!.text).toBe(supplement.text);
    expect(()=>a.enqueue({...supplement,id:"empty",text:" "})).toThrow();
    expect(()=>a.enqueue({...supplement,id:"long",text:"x".repeat(20001)})).toThrow();
    const events=[{eventType:"task_steering_queued",payload:supplement},{eventType:"task_steering_queued",payload:{...supplement,id:"next"}},{eventType:"task_steering_applied",payload:{id:supplement.id}},{eventType:"other",payload:null}];
    expect(recoverSteering(events).map(item=>item.id)).toEqual(["next"]);
    a.acknowledge([supplement.id]);expect(a.peek()).toEqual([]);
  });

  it("requires a successful structured plan before permitting engineering tools",async()=>{
    const {requests,events}=await run([tool("unsafe","file_write",{path:"should-not-exist.txt",content:"bad"}),plan,done,closedPlan,done],{requirePlan:true});
    expect(requests[0]!.tools?.map(item=>item.name)).toEqual(["plan_update"]);
    expect(requests[2]!.tools?.some(item=>item.name==="file_write")).toBe(true);
    expect(events.filter(event=>event.type==="plan_update")).toHaveLength(2);
    expect(JSON.stringify(requests[3]!.messages)).toContain("更新计划不会使证据失效");
    await expect(fs.stat(path.join(cwd,"should-not-exist.txt"))).rejects.toThrow();
    expect(JSON.stringify(requests[1]!.messages)).toContain("unsafe");
    expect(JSON.stringify(requests[1]!.messages)).toContain("本工具未执行");
  });

  it("does not publish invalid plans",async()=>{
    const {events}=await run([tool("invalid","plan_update",{items:[]}),plan,done,closedPlan,done],{requirePlan:true});
    expect(events.filter(event=>event.type==="plan_update")).toHaveLength(2);
  });

  it("cancels unstarted writes and pairs tool results before adding new user direction",async()=>{
    const queue=new SteeringQueue();
    let saved:ConversationMessage[]=[];
    const {result,requests,events}=await run([tool("write","file_write",{path:"cancelled.txt",content:"bad"}),plan,done,closedPlan,done],{
      readSteering:()=>queue.peek(),onSteeringApplied:items=>{expect(saved.some(item=>item.steeringId===supplement.id)).toBe(true);queue.acknowledge(items.map(item=>item.id));},
      onHistoryChange:history=>{saved=structuredClone(history);},requirePlan:true,initialPlan:[{step:"原计划",status:"in_progress"}],
    },(_params,index)=>{if(index===0)queue.enqueue(supplement);});
    await expect(fs.stat(path.join(cwd,"cancelled.txt"))).rejects.toThrow();
    expect(result.updatedHistory[2]!.content).toEqual([expect.objectContaining({type:"tool_result",tool_use_id:"write",is_error:true})]);
    expect(result.updatedHistory[3]!.steeringId).toBe(supplement.id);
    expect(requests[1]!.tools?.map(item=>item.name)).toEqual(["plan_update"]);
    expect(events.filter(event=>event.type==="user_steering")).toHaveLength(1);
    expect(queue.peek()).toEqual([]);
  });

  it("continues when a supplement arrives during the final model response",async()=>{
    const queue=new SteeringQueue();
    const {requests}=await run([done,done],{readSteering:()=>queue.peek(),onSteeringApplied:items=>queue.acknowledge(items.map(item=>item.id))},(_params,index)=>{if(index===0)queue.enqueue(supplement);});
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1]!.messages)).toContain(supplement.text);
  });

  it("finishes an executing write and skips later writes after new direction arrives",async()=>{
    const queue=new SteeringQueue();
    const response={...tool("a","file_write",{path:"first.txt",content:"ok"}),content:[...tool("a","file_write",{path:"first.txt",content:"ok"}).content,...tool("b","file_write",{path:"second.txt",content:"bad"}).content]};
    await run([response,done],{readSteering:()=>queue.peek(),onSteeringApplied:items=>queue.acknowledge(items.map(item=>item.id)),onEvent:event=>{if(event.type==="tool_start")queue.enqueue(supplement);}});
    expect(await fs.readFile(path.join(cwd,"first.txt"),"utf8")).toBe("ok");
    await expect(fs.stat(path.join(cwd,"second.txt"))).rejects.toThrow();
  });

  it("keeps queued supplements durable if conversation persistence fails",async()=>{
    const queue=new SteeringQueue();queue.enqueue(supplement);
    await expect(run([],{readSteering:()=>queue.peek(),onSteeringApplied:items=>queue.acknowledge(items.map(item=>item.id)),onHistoryChange:()=>{throw new Error("disk unavailable");}})).rejects.toThrow("disk unavailable");
    expect(queue.peek()).toHaveLength(1);
  });

  it("does not duplicate a supplement saved before an acknowledgement crash",async()=>{
    const queue=new SteeringQueue();queue.enqueue(supplement);
    const {result}=await run([done],{conversationHistory:[{role:"user",content:supplement.text,steeringId:supplement.id}],readSteering:()=>queue.peek(),onSteeringApplied:items=>queue.acknowledge(items.map(item=>item.id))});
    expect(result.updatedHistory.filter(item=>item.steeringId===supplement.id)).toHaveLength(1);
    expect(queue.peek()).toEqual([]);
  });
});
