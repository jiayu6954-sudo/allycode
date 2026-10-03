import path from "node:path";
import { VisionRuntime } from "../src/vision/runtime.js";
const runtime=new VisionRuntime(path.resolve(".allycode/vision"));
const progress=setInterval(()=>{void runtime.status().then(s=>console.log(JSON.stringify(s)));},30000);
process.once("SIGINT",()=>runtime.cancel());
try {console.log(JSON.stringify(await runtime.install()));}catch(error){console.error(String(error));process.exitCode=1;}finally{clearInterval(progress);await runtime.stop();}
