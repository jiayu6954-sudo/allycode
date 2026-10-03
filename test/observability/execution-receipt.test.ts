import {describe,it,expect} from "vitest";
import {buildExecutionReceipt,renderExecutionReceipt} from "../../src/observability/execution-receipt.js";
import type {TaskEventRecord} from "../../src/storage/agent-database.js";
describe("execution receipt",()=>{
  it("identifies a budget pause without claiming final delivery or no need to fix failures",()=>{
    const events=[{id:1,taskId:"t",runId:"r",createdAt:"now",eventType:"agent_done",payload:{stopReason:"max_iterations"}}] as TaskEventRecord[];
    const receipt=buildExecutionReceipt("t","r",events,{schemaVersion:1,status:"failed",generatedAt:"now",checks:[],summary:"missing"});
    expect(renderExecutionReceipt(receipt)).toContain("系统阶段回执");
    expect(renderExecutionReceipt(receipt)).toContain("达到本轮执行上限");
    expect(renderExecutionReceipt(receipt)).toContain("失败检查仍需继续处理");
    expect(renderExecutionReceipt(receipt)).not.toContain("不需要修改项目文件或重新运行测试");
  });
  it("keeps declaration separate from evidence and excludes other runs",()=>{
    const event=(id:number,eventType:string,payload:unknown,runId="current")=>({id,eventType,payload,runId,taskId:"task",createdAt:"now"}) as TaskEventRecord;
    const receipt=buildExecutionReceipt("task","current",[
      event(1,"agent_tool_result",{toolName:"bash",isError:false},"old"),
      event(2,"agent_plan_update",{items:[{step:"真实设备上线",status:"completed"},{step:"灾备演练",status:"pending"}]}),
      event(3,"agent_tool_result",{toolName:"bash",isError:false,metadata:{evidenceId:"evidence"}}),
    ],{schemaVersion:1,status:"passed",generatedAt:"now",checks:[],summary:"passed"});
    expect(receipt.evidence).toHaveLength(1);expect(receipt.plan[1]?.status).toBe("pending");
    expect(renderExecutionReceipt(receipt)).toContain("不证明所有业务目标");
    expect(renderExecutionReceipt(receipt)).not.toContain("全部完成");
  });
});
