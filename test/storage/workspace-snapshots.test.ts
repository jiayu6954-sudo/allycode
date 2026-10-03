import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceSnapshots, workspaceRevision } from "../../src/storage/workspace-snapshots.js";
import { EvidenceStore } from "../../src/storage/evidence-store.js";
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});});
describe("workspace evidence and recovery",()=>{
  it("restores edits and new files while keeping a recoverable pre-restore version",async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),"allycode-snapshot-"));roots.push(root);
    const cwd=path.join(root,"project");await fs.mkdir(cwd);await fs.writeFile(path.join(cwd,"a.txt"),"before");
    const snapshots=new WorkspaceSnapshots(cwd,path.join(root,"private"));
    const first=await snapshots.create("before");
    expect(await workspaceRevision(cwd)).toBe(first.revision);
    await fs.writeFile(path.join(cwd,"a.txt"),"after");await fs.writeFile(path.join(cwd,"new.txt"),"new");
    const result=await snapshots.restore(first.id);
    expect(await fs.readFile(path.join(cwd,"a.txt"),"utf8")).toBe("before");
    await expect(fs.access(path.join(cwd,"new.txt"))).rejects.toThrow();
    await snapshots.restore(result.recoveryId);
    expect(await fs.readFile(path.join(cwd,"a.txt"),"utf8")).toBe("after");
    expect(await fs.readFile(path.join(cwd,"new.txt"),"utf8")).toBe("new");
  });
  it("retrieves an omitted tail without rerunning a tool, and rejects another workspace",async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),"allycode-evidence-"));roots.push(root);
    const store=new EvidenceStore(path.join(root,"a"),path.join(root,"store"));
    const id=await store.put("x".repeat(60000)+"IMPORTANT FAILURE");
    expect((await store.read(id,60000,100)).content).toBe("IMPORTANT FAILURE");
    await expect(new EvidenceStore(path.join(root,"b"),path.join(root,"store")).read(id)).rejects.toThrow();
    await expect(store.read("../escape")).rejects.toThrow();
  });
});
