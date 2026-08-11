import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(projectRoot, "desktop", "assets", "icon.svg");
const output = path.join(projectRoot, "desktop", "assets", "icon.png");

await fs.access(source);
await sharp(source)
  .resize(512, 512)
  .png({ compressionLevel: 9 })
  .toFile(output);
