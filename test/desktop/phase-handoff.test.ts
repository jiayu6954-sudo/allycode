import {describe,it,expect,vi} from "vitest";
import {DesktopAgentService} from "../../desktop/agent-service.js";
import type {TaskEventRecord} from "../../src/storage/agent-database.js";
const phase={kind:"handoff",title:"核心阶段",summary:"公开交接摘要",document:"ARCHITECTURE.md",nextSteps:["验收"],options:[]};
function service(kind="handoff") {
  const events=[{id:1,runId:"run",eventType:"agent_tool_start",payload:{toolId:"phase",toolName:"phase_checkpoint",input:{...phase,kind,options:kind==="decision"?[{id:"A",title:"本机",tradeoff:"简单"},{id:"B",title:"分布式",tradeoff:"复杂"}]:[]}}},{id:2,runId:"run",eventType:"agent_tool_result",payload:{toolId:"phase",isError:false}}] as TaskEventRecord[];
  const fake=Object.create(DesktopAgentService.prototype);
  fake.database={getTask:()=>({id:"source",status:"paused",projectId:"p",goal:"原始用户目标",sessionId:"old-session"}),getProject:()=>({primaryPath:"D:\\sample"}),listMonitorEvents:()=>events,appendEvent:vi.fn()};
  fake.start=vi.fn(()=>({runId:"next-run",taskId:"child"}));
  return {fake:fake as DesktopAgentService,start:fake.start,events,database:fake.database};
}
describe("desktop phase handoff",()=>{
  it("creates a fresh session scope with linked public handoff and no previous permission/session id",()=>{
    const {fake,start,database}=service();fake.continuePhase("source","phase");
    const request=start.mock.calls[0][0];expect(request.cwd).toBe("D:\\sample");expect(request.prompt).toContain("公开交接摘要");expect(request.sessionId).toBeUndefined();expect(request.taskId).toBeUndefined();
    expect(database.appendEvent).toHaveBeenCalledWith("child","phase_parent",expect.objectContaining({taskId:"source",checkpointId:1}));
  });
  it("validates stale cards and decision choices instead of treating resume as approval",()=>{
    const {fake,start}=service("decision");expect(()=>fake.continuePhase("source","other","A")).toThrow(/过期/);
    expect(()=>fake.continuePhase("source","phase")).toThrow(/方案/);expect(start).not.toHaveBeenCalled();
    fake.continuePhase("source","phase","B");expect(start).toHaveBeenCalledWith(expect.objectContaining({taskId:"source",sessionId:"old-session",prompt:"选择方案 B"}));
  });
  it("rejects duplicate handoffs",()=>{
    const {fake,events}=service();events.push({id:3,eventType:"phase_child",payload:{checkpointId:1}} as TaskEventRecord);
    expect(()=>fake.continuePhase("source","phase")).toThrow(/已选择或交接/);
  });
});
