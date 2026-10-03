import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {executeVisionAnalyze} from "../src/tools/vision-analyze.js";
import {VisionRuntime} from "../src/vision/runtime.js";
const directory=path.resolve(".tmp/vision-understanding",String(Date.now()));await fs.mkdir(directory,{recursive:true});
const chart=path.join(directory,"chart.png");
await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="700"><rect width="1000" height="700" fill="white"/><g fill="#2680bb"><rect x="100" y="240" width="130" height="300"/><rect x="310" y="180" width="130" height="360"/><rect x="520" y="270" width="130" height="270"/><rect x="730" y="150" width="130" height="390"/></g><g font-family="Arial" font-size="40" fill="black"><text x="130" y="590">Q1</text><text x="340" y="590">Q2</text><text x="550" y="590">Q3</text><text x="760" y="590">Q4</text><text x="125" y="225">100</text><text x="335" y="165">120</text><text x="555" y="255">90</text><text x="755" y="135">130</text><text x="100" y="60">Quarterly sample count</text></g></svg>')).png().toFile(chart);
const runtime=new VisionRuntime(path.resolve(".allycode/vision"));
try {for(const [index,input] of [{path:chart,question:"图中哪个季度最高、哪个最低？分别给出标签和数值，并计算差值。只根据图中内容回答。"},{path:path.resolve("output/playwright/vision-settings.png"),question:"这张软件截图中的本地视觉功能使用哪两个模型？当前是否已经安装？请说明图片中的依据。"}].entries()) {const result=await executeVisionAnalyze({action:"analyze",engine:"qwen",...input,output:path.join(directory,String(index)+".json")},{cwd:process.cwd(),timeoutMs:300000,taskId:"vision-understanding-validation"},runtime);console.log(result.content);}}finally{await runtime.stop();}
