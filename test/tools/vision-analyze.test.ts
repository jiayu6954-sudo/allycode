import { describe,it,expect,vi,afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeVisionAnalyze } from "../../src/tools/vision-analyze.js";
import type { VisionBackend } from "../../src/vision/runtime.js";
import { VISION_ASSETS } from "../../src/vision/catalog.js";
const directories:string[]=[];
afterEach(async()=>{for(const dir of directories.splice(0))await fs.rm(dir,{recursive:true,force:true});});
async function fixture(){const cwd=await fs.mkdtemp(path.join(os.tmpdir(),"ally-vision-"));directories.push(cwd);await fs.writeFile(path.join(cwd,"input.png"),"fixture");const analyze=vi.fn(async()=>({text:"金额 1280.50",engine:"paddle" as const,model:"fixture-only",durationMs:1}));const backend={status:vi.fn(),analyze} as unknown as VisionBackend;const render=vi.fn(async()=>({image:"ZmFrZQ==",page:1,totalPages:2,width:100,height:100,sourceWidth:100,sourceHeight:100,resized:false}));return {cwd,backend,render,analyze};}
describe("local vision evidence boundary",()=>{
 it("rejects outside-workspace input before sending images",async()=>{const f=await fixture();await expect(executeVisionAnalyze({action:"analyze",path:"../outside.png",output:"out.json",question:"内容"},f,f.backend,f.render)).rejects.toThrow(/outside/);expect(f.analyze).not.toHaveBeenCalled();});
 it("persists original hash, task scope, page and unknown usage honestly",async()=>{const f=await fixture();const result=await executeVisionAnalyze({action:"analyze",path:"input.png",output:"out.json",engine:"paddle"},{...f,timeoutMs:1000,taskId:"task-one"},f.backend,f.render);const data=JSON.parse(result.content);expect(data).toMatchObject({taskId:"task-one",method:"paddleocr-vl",processedPages:[1],totalPages:2,reviewed:false,usage:{inputTokens:null}});expect(data.sha256).toMatch(/^[a-f0-9]{64}$/);expect(data.image).toBeUndefined();});
 it("does not turn question-answering or crops into whole-page coverage",async()=>{for(const raw of [{engine:"qwen",question:"哪里是按钮？"},{engine:"paddle",region:{x:0,y:0,width:0.5,height:0.5}}]){const f=await fixture();const data=JSON.parse((await executeVisionAnalyze({action:"analyze",path:"input.png",output:"out.json",...raw},{...f,timeoutMs:1000},f.backend,f.render)).content);expect(data.processedPages).toEqual([]);}});
 it("refuses stale source evidence and existing output",async()=>{const f=await fixture();f.analyze.mockImplementation(async()=>{await fs.writeFile(path.join(f.cwd,"input.png"),"changed");return {text:"x",model:"fixture",engine:"paddle",durationMs:1};});await expect(executeVisionAnalyze({action:"analyze",path:"input.png",output:"out.json",engine:"paddle"},{...f,timeoutMs:1000},f.backend,f.render)).rejects.toThrow(/源文件已改变/);await fs.writeFile(path.join(f.cwd,"out.json"),"keep");await expect(executeVisionAnalyze({action:"analyze",path:"input.png",output:"out.json",engine:"paddle"},{...f,timeoutMs:1000},f.backend,f.render)).rejects.toThrow(/不能覆盖/);});
 it("pins every network download to HTTPS, exact size and SHA-256",()=>{expect(VISION_ASSETS.length).toBeGreaterThan(5);for(const asset of VISION_ASSETS){expect(asset.url).toMatch(/^https:\/\//);expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/);expect(asset.bytes).toBeGreaterThan(0);expect(asset.file).not.toContain("..");}});
});
