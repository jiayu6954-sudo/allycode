import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { main: "desktop/main.ts" },
    format: ["esm"],
    target: "node22",
    platform: "node",
    outDir: "dist-desktop",
    clean: false,
    bundle: true,
    sourcemap: true,
    splitting: false,
    // Preserve the `node:` protocol. Electron exposes `node:sqlite`, while
    // stripping the protocol would incorrectly turn it into an npm package.
    external: ["electron", /^node:/],
  },
  {
    entry: { preload: "desktop/preload.ts" },
    format: ["cjs"],
    target: "node22",
    platform: "node",
    outDir: "dist-desktop",
    clean: false,
    bundle: true,
    splitting: false,
    external: ["electron", /^node:/],
    outExtension: () => ({ js: ".cjs" }),
  },
]);
