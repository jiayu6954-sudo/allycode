import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(projectRoot, "dist-desktop");
const relative = path.relative(projectRoot, target);

if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
  throw new Error(`Refusing to clean unexpected path: ${target}`);
}

await fs.rm(target, { recursive: true, force: true });
