import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { assertSafeWorkspaceRoot,resolveWorkspacePath } from "../src/tools/path-guard.js";

/** Call only with paths returned by the native user file picker. */
export async function importVisionFiles(cwd:string,selected:string[]):Promise<string[]> {
  assertSafeWorkspaceRoot(cwd);
  if(selected.length>8)throw new Error("每次最多添加 8 份图片/PDF。");
  for(const file of selected){if(!/\.(png|jpe?g|bmp|tiff?|pdf)$/i.test(file))throw new Error("仅支持图片或 PDF。");const stat=await fs.stat(file);if(!stat.isFile()||stat.size>100*1024*1024)throw new Error("每份资料必须是 100MiB 以内的文件。");}
  const directory=resolveWorkspacePath(cwd,"AllyCode资料");await fs.mkdir(directory,{recursive:true});
  const imported:string[]=[];
  for(const file of selected){const extension=path.extname(file).toLowerCase();const label=Array.from(path.basename(file,extension)).filter(char=>char.charCodeAt(0)>=32).join("").replace(/[<>:"/\\|?*]/g,"_").slice(0,80);const target=resolveWorkspacePath(cwd,path.join(directory,randomUUID().slice(0,8)+"-"+label+extension));await fs.copyFile(file,target,constants.COPYFILE_EXCL);imported.push(path.relative(cwd,target));}
  return imported;
}
