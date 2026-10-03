import {describe,it,expect} from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {PhaseCheckpointSchema,selectedPhaseOption,latestPhaseCheckpoint} from "../../src/agent/phase-workflow.js";
import {ToolRegistry} from "../../src/tools/registry.js";
const phase={kind:"decision" as const,title:"平台架构",summary:"目标与边界",document:"ARCHITECTURE.md",nextSteps:["构建最小闭环"],options:[{id:"A",title:"本机单体",tradeoff:"容易安装，扩容有限"},{id:"B",title:"服务拆分",tradeoff:"可独立扩容，维护成本高"}]};
describe("phase workflow",()=>{
  it("requires meaningful distinct alternatives and explicit user selection",()=>{
    expect(PhaseCheckpointSchema.safeParse({...phase,options:[phase.options[0]]}).success).toBe(false);
    expect(selectedPhaseOption(phase,"继续")).toBeUndefined();
    expect(selectedPhaseOption(phase,"选择方案 A")).toBe("A");
    expect(latestPhaseCheckpoint([])).toBeUndefined();
  });
  it("validates document and blocks implementation while decision is pending",async()=>{
    const cwd=await fs.mkdtemp(path.join(os.tmpdir(),"allycode-phase-"));
    // Temp fixture has no user files; keep mutations limited to this directory.
    try {
      const tools=new ToolRegistry(cwd);tools.setDecisionPending(true);
      expect((await tools.execute("bash",{command:"echo should-not-run"})).isError).toBe(true);
      expect((await tools.execute("file_write",{path:"app.ts",content:"bad"})).isError).toBe(true);
      expect((await tools.execute("phase_checkpoint",phase)).isError).toBe(true);
      expect((await tools.execute("file_write",{path:"ARCHITECTURE.md",content:"Architecture"})).isError).toBe(false);
      expect((await tools.execute("phase_checkpoint",phase)).isError).toBe(false);
      expect((await tools.execute("phase_checkpoint",{...phase,kind:"handoff"})).isError).toBe(true);
      tools.setDecisionPending(false);
      expect((await tools.execute("file_write",{path:"app.ts",content:"approved"})).isError).toBe(false);
    } finally { await fs.rm(cwd,{recursive:true,force:true}); }
  });
});
