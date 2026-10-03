import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeSourcesExcel, hashDocument } from "../../src/tools/sources-to-excel.js";
import { executeDocumentOcr } from "../../src/tools/document-ocr.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PermissionManager } from "../../src/permissions/manager.js";
import { SettingsSchema } from "../../src/config/schema.js";

const roots: string[] = [];
async function fixture() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ally-document-")); roots.push(cwd);
  return { cwd, timeoutMs: 10000 };
}
afterEach(async()=>{ for(const root of roots.splice(0)) await fs.rm(root,{recursive:true,force:true}); });

describe("document artifact boundaries",()=>{
  it("paginates every manifest segment and blocks binary text reads",async()=>{
    const ctx=await fixture();
    await fs.writeFile(path.join(ctx.cwd,"m.json"),JSON.stringify({files:[{id:"F1",path:"source.txt",status:"extracted",segments:[{locator:"line:1",text:"a"},{locator:"line:2",text:"b"},{locator:"line:3",text:"c"}]}]}));
    const first=JSON.parse((await executeSourcesExcel({action:"inspect",request:{manifest:"m.json",fileId:"F1",start:0,limit:2}},ctx)).content);
    const last=JSON.parse((await executeSourcesExcel({action:"inspect",request:{manifest:"m.json",fileId:"F1",start:first.next,limit:2}},ctx)).content);
    expect(first.total).toBe(3);expect(last.next).toBeNull();expect([...first.items,...last.items].map(item=>item.text)).toEqual(["a","b","c"]);
    const result=await new ToolRegistry(ctx.cwd).execute("file_read",{path:"scan.pdf"});
    expect(result.isError).toBe(true);expect(result.content).toContain("document_ocr");
  });
  it("rejects outside source/output paths and a manifest beside input before invoking Python",async()=>{
    const ctx=await fixture();
    await expect(executeSourcesExcel({action:"scan",request:{inputs:["../other"],output:"result/m.json"}},ctx)).rejects.toThrow(/outside/);
    await expect(executeSourcesExcel({action:"scan",request:{inputs:["."],output:"../m.json"}},ctx)).rejects.toThrow(/outside/);
    await expect(executeSourcesExcel({action:"scan",request:{inputs:["."],output:"m.json"}},ctx)).rejects.toThrow(/独立结果/);
  });
  it("rejects a nested directory junction instead of silently scanning outside the workspace",async()=>{
    const ctx=await fixture(), outside=await fixture();
    await fs.mkdir(path.join(ctx.cwd,"input"));
    await fs.symlink(outside.cwd,path.join(ctx.cwd,"input","junction"),process.platform==="win32"?"junction":"dir");
    await expect(executeSourcesExcel({action:"scan",request:{inputs:["input"],output:"result/m.json"}},ctx)).rejects.toThrow(/符号链接|outside/);
  });
  it("attaches OCR with source hashes, idempotent positions and no fabricated review",async()=>{
    const ctx=await fixture();
    const source=path.join(ctx.cwd,"source.png"); await fs.writeFile(source,"fixture");
    const sha256=await hashDocument(source);
    const manifest={files:[{id:"F1",path:source,sha256,status:"needs_ocr",segments:[]}]};
    await fs.writeFile(path.join(ctx.cwd,"manifest.json"),JSON.stringify(manifest));
    const ocr={source,sha256,method:"windows-ocr",totalPages:2,processedPages:[1],segments:[{locator:"page:1:ocr:line:1",page:1,text:"00123",reviewed:true}]};
    await fs.writeFile(path.join(ctx.cwd,"ocr.json"),JSON.stringify(ocr));
    const request={manifest:"manifest.json",fileId:"F1",ocr:"ocr.json"};
    await executeSourcesExcel({action:"attach_ocr",request},ctx);
    await executeSourcesExcel({action:"attach_ocr",request},ctx);
    const saved=JSON.parse(await fs.readFile(path.join(ctx.cwd,"manifest.json"),"utf8"));
    expect(saved.files[0].segments).toHaveLength(1); expect(saved.files[0].segments[0].reviewed).toBe(false);
    expect(saved.files[0].status).toBe("needs_ocr");expect(saved.files[0].ocrPages).toEqual([1]);
    await expect(executeSourcesExcel({action:"build",request:{manifest:"manifest.json",output:"result.xlsx",coverage:{F1:{status:"included"}},sheets:[]}},ctx)).rejects.toThrow(/页覆盖/);
    await fs.writeFile(source,"changed");
    await expect(executeSourcesExcel({action:"attach_ocr",request},ctx)).rejects.toThrow(/哈希/);
  });
  it("does not reuse a scan permission for network setup and denies writes in read-only mode",async()=>{
    const prompts:string[]=[];
    const manager=new PermissionManager(SettingsSchema.parse({}),async req=>{prompts.push(String((req.input as Record<string,unknown>).action));return "allow-session";});
    await manager.request("sources_to_excel",{action:"scan"});
    await manager.request("sources_to_excel",{action:"setup"});
    expect(prompts).toEqual(["scan","setup"]);
    const readOnly=PermissionManager.createReadOnly(SettingsSchema.parse({}));
    expect(await readOnly.request("sources_to_excel",{action:"build"})).toBe("deny");
    expect(await readOnly.request("document_ocr",{action:"recognize"})).toBe("deny");
  });
  it("clears stale manifest cache after a failed or successful native artifact mutation",async()=>{
    const ctx=await fixture(), registry=new ToolRegistry(ctx.cwd);
    await fs.writeFile(path.join(ctx.cwd,"m.json"),"old");
    expect((await registry.execute("file_read",{path:"m.json"})).content).toContain("old");
    await fs.writeFile(path.join(ctx.cwd,"m.json"),"new");
    await registry.execute("sources_to_excel",{action:"attach_ocr",request:{manifest:"missing"}});
    expect((await registry.execute("file_read",{path:"m.json"})).content).toContain("new");
  });
  it.skipIf(process.platform!=="win32")("rejects OCR traversal, existing output and unbounded page batches without spawning recognition",async()=>{
    const ctx=await fixture();
    await expect(executeDocumentOcr({action:"recognize",path:"../a.png",output:"a.json"},ctx)).rejects.toThrow(/outside/);
    await fs.writeFile(path.join(ctx.cwd,"existing.json"),"keep");
    await expect(executeDocumentOcr({action:"recognize",path:"a.png",output:"existing.json"},ctx)).rejects.toThrow(/已存在/);
    await expect(executeDocumentOcr({action:"recognize",path:"a.png",output:"a.json",endPage:11},ctx)).rejects.toThrow(/10 页/);
  });
});
