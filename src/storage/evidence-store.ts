import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { DATA_DIR } from "../config/settings.js";

/** Immutable outputs, scoped to their originating workspace; no model state. */
export class EvidenceStore {
  private directory: string;
  constructor(cwd: string, root = path.join(DATA_DIR, "evidence")) {
    this.directory = path.join(root, createHash("sha256").update(path.resolve(cwd)).digest("hex"));
  }
  async put(content: string): Promise<string> {
    const id = createHash("sha256").update(content).digest("hex");
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(this.directory, `${id}.txt`), content, { flag: "wx", mode: 0o600 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    return id;
  }
  async read(id: string, start = 0, length = 12000): Promise<{content: string; totalChars: number}> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("证据 ID 无效");
    if (!Number.isInteger(start) || start < 0 || !Number.isInteger(length) || length < 1 || length > 12000) throw new Error("证据读取范围无效");
    const content = await fs.readFile(path.join(this.directory, `${id}.txt`), "utf8");
    if (createHash("sha256").update(content).digest("hex") !== id) throw new Error("证据完整性检查失败");
    return { content: content.slice(start, start + length), totalChars: content.length };
  }
}
