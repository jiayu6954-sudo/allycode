import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: false,
  splitting: false,
  // Keep all node_modules as external — npm will install them
  // Only bundle src/ (our own code)
  bundle: true,
  dts: false,
  minify: false,
  external: [
    // node: built-ins
    /^node:/,
    // all npm packages stay external (installed via dependencies)
    "ink", "react", "commander", "zod", "@anthropic-ai/sdk",
    "ansi-escapes", "chalk", "execa", "fast-glob", "mime-types",
    "ora", "string-width", "strip-ansi",
  ],
});
