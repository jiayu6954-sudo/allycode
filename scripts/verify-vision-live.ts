import path from "node:path";
import fs from "node:fs/promises";
import { executeVisionAnalyze } from "../src/tools/vision-analyze.js";
import { VisionRuntime } from "../src/vision/runtime.js";
const engine=process.argv[2]==="qwen"?"qwen":"paddle";
const directory=path.resolve(".tmp/vision-live",engine+"-"+Date.now());await fs.mkdir(directory,{recursive:true});
const runtime=new VisionRuntime(path.resolve(".allycode/vision"));
try {
  for(const [index,source] of ["receipt.png","scanned.pdf"].entries()) {
    const result=await executeVisionAnalyze({action:"analyze",path:path.resolve(".tmp/alpha17-fixture/input",source),output:path.join(directory,String(index)+".json"),engine,question:engine==="qwen"?"请逐项抄录这张票据的编号、数量和金额，保留前导零和小数点；不要计算或补全看不清的数字。":undefined,page:source.endsWith("pdf")?3:1},{cwd:process.cwd(),timeoutMs:300000,taskId:"vision-local-validation"},runtime);
    const data=JSON.parse(result.content);console.log(JSON.stringify({output:data.output,model:data.model,geometry:data.geometry,usage:data.usage,segments:data.segments}));
  }
}finally{await runtime.stop();}
