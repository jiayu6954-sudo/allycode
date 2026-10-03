import {describe,expect,it} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {createElement} from "react";
import {conversationTools,toDesktopMessages,updateInlinePlan} from "../../desktop/conversation-view.js";
import {TaskPlan} from "../../desktop/renderer/src/TaskPlan.js";
import type {ConversationMessage} from "../../src/types/agent.js";
import type {PlanUpdateInput} from "../../src/types/tools.js";

const plan = (status: "pending" | "completed"): PlanUpdateInput["items"] => [{step:"检查并修复项目",status}];
const call = (id:string,name:string,input:Record<string,unknown>): ConversationMessage => ({role:"assistant",content:[{type:"tool_use",id,name,input}]});
const result = (id:string,is_error=false): ConversationMessage => ({role:"user",content:[{type:"tool_result",tool_use_id:id,content:is_error?"检查失败":"检查通过",is_error}]});

describe("conversation history and inline plans",()=>{
  it("replays successful plans in place and retains tool execution results",()=>{
    const messages=toDesktopMessages([
      {role:"user",content:"修复项目"},call("p1","plan_update",{items:plan("pending")}),result("p1"),
      call("tool","bash",{command:"npm test"}),result("tool",true),
      call("p2","plan_update",{items:plan("completed")}),result("p2"),
      {role:"assistant",content:"仍需处理验收失败。"},
    ]);
    expect(messages).toHaveLength(2);
    expect(messages[1]!.content.filter(b=>b.type==="plan")).toEqual([{type:"plan",items:plan("completed")}]);
    expect(messages[1]!.content[0]!.type).toBe("plan");
    expect(conversationTools(messages).find(b=>b.toolId==="tool")).toMatchObject({status:"error",result:"检查失败"});
  });
  it("does not mark interrupted or failed tool calls successful",()=>{
    const messages=toDesktopMessages([call("pending","file_read",{path:"a.ts"}),call("bad","plan_update",{items:plan("completed")}),result("bad",true)]);
    expect(conversationTools(messages)[0]!.status).toBe("pending");
    expect(messages.flatMap(m=>m.content).some(b=>b.type==="plan")).toBe(false);
  });
  it("keeps each user turn's checklist and reused tool identifiers independent",()=>{
    const messages=toDesktopMessages([
      {role:"user",content:"第一项"},call("p","plan_update",{items:plan("completed")}),result("p"),
      {role:"user",content:"第二项"},call("p","plan_update",{items:plan("pending")}),result("p"),
    ]);
    expect(messages.filter(m=>m.role==="assistant").map(m=>m.content.find(b=>b.type==="plan"))).toEqual([{type:"plan",items:plan("completed")},{type:"plan",items:plan("pending")}]);
  });
  it("never leaks another session's tools or provider state",()=>{
    const first=[call("shared","file_read",{path:"D:/project-a/private.ts"}),result("shared")];
    const original=structuredClone(first);
    toDesktopMessages(first);
    const next=toDesktopMessages([{role:"user",content:"另一个项目"},result("shared")]);
    expect(conversationTools(next)).toEqual([]);
    expect(JSON.stringify(next)).not.toContain("private.ts");
    expect(first).toEqual(original);
    const withPrivate=toDesktopMessages([{role:"assistant",content:[{type:"thinking",thinking:"PRIVATE_REASONING",signature:"secret"},{type:"text",text:"公开结论"}]}]);
    expect(JSON.stringify(withPrivate)).not.toContain("PRIVATE_REASONING");
  });
  it("ignores malformed historical plans without losing their tool records",()=>{
    const messages=toDesktopMessages([call("bad","plan_update",{items:[{step:"x",status:"invented"}]}),result("bad")]);
    expect(messages[0]!.content.some(b=>b.type==="plan")).toBe(false);
    expect(conversationTools(messages)).toHaveLength(1);
  });
  it("updates a live plan without moving it after subsequent text or mutating old content",()=>{
    const original=updateInlinePlan([{type:"text",text:"开始"}],plan("pending"));
    const next=updateInlinePlan([...original,{type:"text",text:"已验证"}],plan("completed"));
    expect(next.map(b=>b.type)).toEqual(["text","plan","text"]);
    expect(original[1]).toEqual({type:"plan",items:plan("pending")});
  });
  it("renders checklist statuses without a user approval control",()=>{
    const html=renderToStaticMarkup(createElement(TaskPlan,{items:[...plan("completed"),{step:"实际验证",status:"in_progress"},{step:"汇报",status:"pending"}],running:true}));
    expect(html).toContain("1 / 3 步完成");
    for(const label of ["已完成","进行中","待开始"])expect(html).toContain(label);
    expect(html).not.toContain("<button");expect(html).not.toContain("checkbox");
  });
});
