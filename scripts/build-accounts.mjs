import { build } from "esbuild";
await build({entryPoints:["src/accounts/server.ts"],outfile:"dist-account/server.mjs",bundle:true,platform:"node",format:"esm",target:"node22",packages:"bundle"});
