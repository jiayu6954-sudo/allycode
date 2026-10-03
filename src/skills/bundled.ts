import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "../config/settings.js";

/** Resolve trusted application assets independently of the user's project cwd. */
export function sourcesExcelDirectory(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    ...(resources ? [path.join(resources, "skills", "sources-to-excel")] : []),
    ...["..", "../.."].map(up => path.resolve(moduleDirectory, up, "skill/sources-to-excel-complete/sources-to-excel")),
  ];
  const found = candidates.find(directory => fs.existsSync(path.join(directory, "SKILL.md")));
  if (!found) throw new Error("内置 Excel 技能资源缺失，请重新安装完整 AllyCode 包。");
  return found;
}

/** Shared application components; never derived from a user's active task path. */
export function documentsDirectory(): string {
  return path.resolve(process.env.ALLYCODE_DOCUMENT_HOME ?? (process.env.ALLYCODE_VISION_HOME
    ? path.join(process.env.ALLYCODE_VISION_HOME, "../documents")
    : path.join(DATA_DIR, "components/documents")));
}
