import {it,expect,afterEach} from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {importVisionFiles} from "../../desktop/vision-import.js";
const roots:string[]=[];
async function root(){const value=await fs.mkdtemp(path.join(os.tmpdir(),"ally-vision-import-"));roots.push(value);return value;}
afterEach(async()=>{for(const value of roots.splice(0))await fs.rm(value,{recursive:true,force:true});});
it("copies user-picked documents into unique project files without altering originals",async()=>{const cwd=await root(),outside=await root(),file=path.join(outside,"receipt.png");await fs.writeFile(file,"sample");const first=await importVisionFiles(cwd,[file]);const second=await importVisionFiles(cwd,[file]);expect(first[0]).not.toBe(second[0]);expect(await fs.readFile(path.join(cwd,first[0]),"utf8")).toBe("sample");expect(await fs.readFile(file,"utf8")).toBe("sample");});
it("rejects a project attachment directory junction to another project",async()=>{const cwd=await root(),outside=await root(),file=path.join(outside,"receipt.png");await fs.writeFile(file,"sample");await fs.symlink(outside,path.join(cwd,"AllyCode资料"),process.platform==="win32"?"junction":"dir");await expect(importVisionFiles(cwd,[file])).rejects.toThrow(/outside/);});
it("rejects unsupported file types before copying",async()=>{const cwd=await root();await expect(importVisionFiles(cwd,[path.join(cwd,"run.exe")])).rejects.toThrow(/仅支持/);});
