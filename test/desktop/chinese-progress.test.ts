import {describe,expect,it,vi} from "vitest";
import {DesktopAgentService} from "../../desktop/agent-service.js";
import {buildSystemPrompt} from "../../src/agent/system-prompt.js";
import {SettingsSchema} from "../../src/config/schema.js";
import type {DesktopAgentEvent} from "../../desktop/shared.js";

describe("Chinese progress and private reasoning boundary",()=>{
  it("sends only a progress signal, while preserving the original provider event",()=>{
    const send=vi.fn();
    const service=Object.create(DesktopAgentService.prototype) as {webContents:()=>unknown;send:(event:DesktopAgentEvent)=>void};
    service.webContents=()=>({isDestroyed:()=>false,send});
    const event:DesktopAgentEvent={runId:"test",event:{type:"thinking_delta",delta:"PRIVATE_PROVIDER_STATE"}};
    service.send(event);
    expect(send).toHaveBeenCalledWith("agent:event",{runId:"test",event:{type:"thinking_delta",delta:""}});
    expect(event.event.delta).toBe("PRIVATE_PROVIDER_STATE");
  });
  it("keeps replies intact rather than replacing English output with an unrelated translation",()=>{
    const send=vi.fn();
    const service=Object.create(DesktopAgentService.prototype) as {webContents:()=>unknown;send:(event:DesktopAgentEvent)=>void};
    service.webContents=()=>({isDestroyed:()=>false,send});
    const event:DesktopAgentEvent={runId:"test",event:{type:"text_delta",delta:"API / src/main.ts"}};
    service.send(event);expect(send).toHaveBeenCalledWith("agent:event",event);
  });
  it("reasserts Chinese communication after project context, including resumed conversations",async()=>{
    const prompt=await buildSystemPrompt(process.cwd(),"Existing project documentation is in English.",SettingsSchema.parse({memory:{enabled:false}}));
    expect(prompt.lastIndexOf("默认用简体中文")).toBeGreaterThan(prompt.indexOf("Existing project"));
    expect(prompt).toContain("恢复旧任务");expect(prompt).toContain("每完成一步立即更新计划");
    expect(prompt).toContain("现在解决什么？");expect(prompt).toContain("不是内部思考实录");
    expect(prompt).toContain("独立门禁尚未返回");expect(prompt).toContain("900000 ms");
  });
});
