import { expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renderVisionPage } from "../../src/tools/vision-analyze.js";
import { executeDocumentOcr } from "../../src/tools/document-ocr.js";
import { documentProcess } from "../../src/tools/local-document-process.js";
import { findPython } from "../../src/tools/sources-to-excel.js";
import { LINUX_VISION_ASSETS, WINDOWS_VISION_ASSETS } from "../../src/vision/catalog.js";

it("retains identical model weights across Windows and Linux with pinned platform runtimes",()=>{
  expect(LINUX_VISION_ASSETS.filter(a=>!a.file.startsWith("downloads/"))).toEqual(WINDOWS_VISION_ASSETS.filter(a=>!a.file.startsWith("downloads/")));
  expect(LINUX_VISION_ASSETS.slice(0,2).every(a=>a.sha256.length===64&&a.bytes>0&&!a.url.endsWith(".zip"))).toBe(true);
});
it.skipIf(process.platform!=="linux")("renders an actual multi-page PDF and recognizes real pixels with Linux OCR",async()=>{
  const cwd=await fs.mkdtemp(path.join(os.tmpdir(),"ally-linux-")); const ctx={cwd,timeoutMs:180000};
  try {
    const python=await findPython(ctx,["PIL","pypdfium2"]);expect(python?.ready).toBe(true);
    await documentProcess(python!.command,[...python!.args,"-I","-c","from PIL import Image,ImageDraw,ImageFont; a=Image.new('RGB',(1400,800),'white');d=ImageDraw.Draw(a);f=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',50);d.text((80,100),'INVOICE 00123',font=f,fill='black');d.text((80,200),'TOTAL 1280.50',font=f,fill='black');a.save('input.png');a.save('input.pdf',save_all=True,append_images=[a])"],ctx);
    const rendered=await renderVisionPage({path:path.join(cwd,"input.pdf"),page:2},ctx);
    expect(rendered.totalPages).toBe(2);expect(rendered.image.length).toBeGreaterThan(100);
    await expect(renderVisionPage({path:path.join(cwd,"input.pdf"),page:3},ctx)).rejects.toThrow();
    const result=JSON.parse((await executeDocumentOcr({action:"recognize",path:"input.png",output:"ocr.json",startPage:1,endPage:1},ctx)).content);
    expect(result.method).toBe("tesseract-ocr");expect(result.reviewed).toBe(false);
    expect(JSON.stringify(result.segments)).toContain("00123");expect(JSON.stringify(result.segments)).toContain("1280.50");
    await expect(executeDocumentOcr({action:"recognize",path:"input.png",output:"ocr.json"},ctx)).rejects.toThrow(/已存在/);
  } finally {await fs.rm(cwd,{recursive:true,force:true});}
},180000);
