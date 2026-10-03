/** Maintenance downloader: bounded range requests, resumable parts, final pinned digest. */
import fs from "node:fs/promises";
import path from "node:path";
import { createReadStream,createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { execa } from "execa";
import { VISION_ASSETS } from "../src/vision/catalog.js";
import { hashAsset } from "../src/vision/runtime.js";
const asset=VISION_ASSETS.find(a=>a.bytes>6e9)!;
const root=path.resolve(".allycode/vision"),file=path.join(root,asset.file),parts=path.join(root,"qwen-parts");
await fs.mkdir(parts,{recursive:true});
const checkpoint=path.join(parts,"checkpoint.json");
let start:number;
try{start=JSON.parse(await fs.readFile(checkpoint,"utf8")).start;}catch{start=await fs.stat(file).then(s=>s.size,()=>0);await fs.writeFile(checkpoint,JSON.stringify({start,sha256:asset.sha256}),{flag:"wx"});}
if((await fs.stat(file).then(s=>s.size,()=>0))!==start)throw new Error("Base file changed; refusing to append inconsistent ranges");
const chunkSize=64*1024*1024;
const jobs=Array.from({length:Math.ceil((asset.bytes-start)/chunkSize)},(_,index)=>({index,first:start+index*chunkSize,last:Math.min(asset.bytes-1,start+(index+1)*chunkSize-1)}));
let cursor=0,completed=0;
const controller=new AbortController();process.once("SIGINT",()=>controller.abort());
const timer=setInterval(()=>console.log(JSON.stringify({completed,total:jobs.length,message:"Qwen bounded parallel download"})),30000);
try {
 await Promise.all(Array.from({length:8},async()=>{while(cursor<jobs.length){const job=jobs[cursor++],part=path.join(parts,String(job.index)+".part"),length=job.last-job.first+1;
 if(await fs.stat(part).then(s=>s.size===length,()=>false)){completed++;continue;}
 for(let attempt=0;attempt<4;attempt++){try{await execa("curl.exe",["-sSfL","--proto","=https","--proto-redir","=https","--connect-timeout","30","--max-time","600","--max-filesize",String(length),"--range",`${job.first}-${job.last}`,"-o",part,asset.url],{windowsHide:true,cancelSignal:controller.signal,maxBuffer:100000});if((await fs.stat(part)).size!==length)throw new Error("Incomplete range");break;}catch(error){controller.signal.throwIfAborted();if(attempt===3)throw error;}}
 completed++;
 }}));
 const assembled=file+".assembling";
 await pipeline(createReadStream(file),createWriteStream(assembled,{flags:"w"}));
 for(const job of jobs)await pipeline(createReadStream(path.join(parts,String(job.index)+".part")),createWriteStream(assembled,{flags:"a"}));
 if(await hashAsset(assembled)!==asset.sha256)throw new Error("Qwen full SHA-256 mismatch; original file preserved");
 await fs.rename(assembled,file);
 for(const job of jobs)await fs.unlink(path.join(parts,String(job.index)+".part"));
 await fs.unlink(checkpoint);
 console.log("Qwen download verified: "+asset.sha256);
}finally{controller.abort();clearInterval(timer);}
