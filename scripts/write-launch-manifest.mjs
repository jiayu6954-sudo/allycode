import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
const build = JSON.parse(await fs.readFile(".tmp/build-provenance.json", "utf8"));
const packageRoot = process.argv[2] ?? "win-unpacked";
const resolvedRoot = path.resolve("release", packageRoot);
if (!resolvedRoot.startsWith(path.resolve("release") + path.sep)) throw new Error("Package must be inside release.");
const executable = `${packageRoot}/AllyCode.exe`;
const archive = `${packageRoot}/resources/app.asar`;
const digest = async (relative) => createHash("sha256").update(await fs.readFile(path.join("release", relative))).digest("hex");
const resources=[];
async function listResources(relative) {
  for(const entry of await fs.readdir(path.join("release",relative),{withFileTypes:true})) {
    const name=`${relative}/${entry.name}`;
    if(entry.isDirectory())await listResources(name);
    else resources.push({path:name,sha256:await digest(name)});
  }
}
await listResources(`${packageRoot}/resources/skills/sources-to-excel`);
for(const name of ["account-service.json","update-sources.json"]){const file=`${packageRoot}/resources/${name}`;resources.push({path:file,sha256:await digest(file)});}
await fs.writeFile("release/launch-manifest.next.json", JSON.stringify({ ...build, executable, executableSha256: await digest(executable), archive, archiveSha256: await digest(archive), resources }, null, 2));
await fs.rename("release/launch-manifest.next.json", "release/launch-manifest.json");
console.log(`Launch manifest ready: ${build.version}`);
