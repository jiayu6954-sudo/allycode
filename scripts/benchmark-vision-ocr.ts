import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { VisionRuntime } from "../src/vision/runtime.js";
import { executeVisionAnalyze } from "../src/tools/vision-analyze.js";
const root=path.resolve(".tmp/vision-ocr-benchmark",String(Date.now()));await fs.mkdir(root,{recursive:true});
const runtime=new VisionRuntime(path.resolve(".allycode/vision"));
const results:unknown[]=[];
try {
 for(let i=0;i<40;i++) {
  const id=String(123+i).padStart(5,"0"),quantity=12+i,amount=(1280.50+i*10.03).toFixed(2);
  const mode=i%5;
  const labels=mode===3?["科研实验记录","样本编号","样本数量","费用"]:mode===4?["数据校验清单","记录编号","记录数量","数值"]:["资料整理测试 收据","编号","数量","金额"];
  const table=mode===1?'<path d="M60 100H1350V360H60Z M60 185H1350 M60 270H1350 M350 100V360" fill="none" stroke="#333" stroke-width="2"/>':'';
  const svg=`<svg width="1500" height="480" xmlns="http://www.w3.org/2000/svg"><rect width="1500" height="480" fill="white"/>${table}<g font-family="Microsoft YaHei" font-size="32" fill="#111"><text x="80" y="65">${labels[0]}</text><text x="80" y="155">${labels[1]}</text><text x="420" y="155">${id}</text><text x="80" y="240">${labels[2]}</text><text x="420" y="240">${quantity}</text><text x="80" y="325">${labels[3]}</text><text x="420" y="325">${amount}</text></g></svg>`;
  const input=path.join(root,`${i}.png`);let img=sharp(Buffer.from(svg));if(mode===2)img=img.rotate(3,{background:"white"});await img.png().toFile(input);
  const result=JSON.parse((await executeVisionAnalyze({action:"analyze",path:input,output:path.join(root,`${i}.json`),engine:"paddle"},{cwd:process.cwd(),timeoutMs:300000,taskId:"synthetic-ocr-benchmark"},runtime)).content);
  const raw=result.segments.map((s:{text:string})=>s.text).join("\n");const passed=[id,String(quantity),amount].every(value=>new RegExp(`(?<![0-9.])${value.replaceAll(".","\\.")}(?![0-9.])`).test(raw));
  results.push({index:i,variant:mode,expected:{id,quantity,amount},passed,usage:result.usage,evidence:result.output});
  console.log(JSON.stringify({index:i,passed,output:result.output}));
 }
}finally{await runtime.stop();await fs.writeFile(path.join(root,"summary.json"),JSON.stringify({scope:"40 synthetic generated images; exact numeric token checks, not layout or real-world accuracy",results},null,2));console.log("Summary: "+path.join(root,"summary.json"));}
