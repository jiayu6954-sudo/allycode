import fs from "node:fs/promises";
import {createHash} from "node:crypto";
import {extractFile} from "@electron/asar";
import path from "node:path";
const manifest=JSON.parse(await fs.readFile("release/launch-manifest.json","utf8"));
const asarPath=path.resolve("release",manifest.archive);
if(!asarPath.startsWith(path.resolve("release")+path.sep))throw new Error("Invalid package path");
const hash=(value)=>createHash("sha256").update(value).digest("hex");
const files=["dist-desktop/main.js","dist-desktop/preload.cjs","dist/index.js"];
async function rendererFiles(directory){for(const entry of await fs.readdir(directory,{withFileTypes:true})){const name=path.join(directory,entry.name);if(entry.isDirectory())await rendererFiles(name);else files.push(name.replaceAll('\\','/'));}}
await rendererFiles("dist-desktop/renderer");
for(const name of files){
  const local=await fs.readFile(name);
  const packaged=extractFile(asarPath,path.normalize(name));
  if(hash(local)!==hash(packaged))throw new Error(`Packaged file mismatch: ${name}`);
}
const main=extractFile(asarPath,path.normalize("dist-desktop/main.js")).toString("utf8");
const resourceFiles=[];
async function verifyResources(relative="") {
  const sourceRoot="skill/sources-to-excel-complete/sources-to-excel";
  for(const entry of await fs.readdir(path.join(sourceRoot,relative),{withFileTypes:true})) {
    if(["__pycache__",".venv"].includes(entry.name))continue;
    const name=path.join(relative,entry.name);
    if(entry.isDirectory())await verifyResources(name);
    else {
      const local=await fs.readFile(path.join(sourceRoot,name));
      const packaged=await fs.readFile(path.join(path.dirname(asarPath),"skills/sources-to-excel",name));
      if(hash(local)!==hash(packaged))throw new Error(`Packaged skill mismatch: ${name}`);
      resourceFiles.push(name.replaceAll('\\','/'));
    }
  }
}
await verifyResources();
for(const name of ["account-service.json","update-sources.json"])if(hash(await fs.readFile(name))!==hash(await fs.readFile(path.join(path.dirname(asarPath),name))))throw new Error(`Packaged config mismatch: ${name}`);
if(!main.includes(manifest.sourceHash)||!main.includes("desktop_control"))throw new Error("Missing build identity or embedded desktop tool.");
const test=JSON.parse(await fs.readFile(process.argv[2] ?? ".tmp/optimization-final-acceptance.json","utf8"));
if(!test.success||test.numFailedTests)throw new Error("Regression tests did not pass.");
const result={version:manifest.version,sourceHash:manifest.sourceHash,packageFilesMatch:true,filesCompared:files,skillResourcesCompared:resourceFiles,tests:{total:test.numTotalTests,passed:test.numPassedTests,failed:test.numFailedTests},verifiedAt:new Date().toISOString()};
await fs.writeFile(".tmp/local-package-verification.json",JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
