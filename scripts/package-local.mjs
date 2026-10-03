import fs from "node:fs/promises";
import path from "node:path";
import {execFileSync} from "node:child_process";
const build=JSON.parse(await fs.readFile(".tmp/build-provenance.json","utf8"));
const directory=`local/${build.version}-${build.sourceHash.slice(0,12)}-${Date.now()}`;
const output=path.join("release",directory);
// Always stage in a fresh directory: a running Windows exe must never be overwritten.
await fs.mkdir(output,{recursive:true});
execFileSync(process.execPath,["node_modules/electron-builder/cli.js","--win","--dir","--publish","never",`--config.directories.output=${output}`],{stdio:"inherit",windowsHide:true});
execFileSync(process.execPath,["scripts/write-launch-manifest.mjs",`${directory}/win-unpacked`],{stdio:"inherit",windowsHide:true});
