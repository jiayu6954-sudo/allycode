import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { createHash, randomUUID } from "node:crypto";
import { DATA_DIR } from "../config/settings.js";
import { assertSafeWorkspaceRoot, resolveWorkspacePath } from "../tools/path-guard.js";

const EXCLUDED = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/dist-desktop/**", "**/release/**", "**/coverage/**", "**/.tmp/**", "**/.allycode-eval/**", "**/.next/**", "**/.venv/**", "**/*.log", "**/.e2e*/**"];
export interface WorkspaceSnapshot { id: string; cwd: string; createdAt: string; label: string; revision: string; files: Record<string, string>; }
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

async function readWorkspace(cwd: string): Promise<Record<string, Buffer>> {
  assertSafeWorkspaceRoot(cwd);
  const entries = await fg("**/*", { cwd, dot: true, onlyFiles: true, followSymbolicLinks: false, ignore: EXCLUDED });
  if (entries.length > 10000) throw new Error("项目超过 10000 个文件，暂不支持完整快照；请选择更小的项目目录。");
  const files: Record<string, Buffer> = Object.create(null) as Record<string, Buffer>;
  let size = 0;
  for (const entry of entries.sort()) {
    const target = resolveWorkspacePath(cwd, entry);
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) throw new Error("快照不支持符号链接文件");
    size += stat.size;
    if (size > 100 * 1024 * 1024) throw new Error("项目快照超过 100MB，请缩小项目范围。");
    files[entry] = await fs.readFile(target);
  }
  return files;
}

export async function workspaceRevision(cwd: string): Promise<string> {
  const files = await readWorkspace(cwd);
  return hash(JSON.stringify(Object.entries(files).map(([name, content]) => [name, hash(content)])));
}

export class WorkspaceSnapshots {
  private root: string;
  constructor(private cwd: string, root = path.join(DATA_DIR, "snapshots")) { this.root = path.join(root, hash(path.resolve(cwd))); }
  async create(label: string): Promise<WorkspaceSnapshot> {
    const contents = await readWorkspace(this.cwd);
    const files: Record<string, string> = Object.create(null) as Record<string, string>;
    await fs.mkdir(path.join(this.root, "objects"), { recursive: true, mode: 0o700 });
    for (const [name, content] of Object.entries(contents)) {
      const id = hash(content); files[name] = id;
      await fs.writeFile(path.join(this.root, "objects", id), content, { flag: "wx", mode: 0o600 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    }
    const snapshot: WorkspaceSnapshot = { id: randomUUID(), cwd: path.resolve(this.cwd), createdAt: new Date().toISOString(), label, files, revision: hash(JSON.stringify(Object.entries(files))) };
    await fs.writeFile(path.join(this.root, `${snapshot.id}.json`), JSON.stringify(snapshot), { flag: "wx", mode: 0o600 });
    return snapshot;
  }
  async list(): Promise<WorkspaceSnapshot[]> {
    const entries = await fs.readdir(this.root).catch(() => [] as string[]);
    return (await Promise.all(entries.filter((name) => name.endsWith(".json")).map(async (name) => JSON.parse(await fs.readFile(path.join(this.root, name), "utf8")) as WorkspaceSnapshot))).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  }
  async restore(id: string): Promise<{ restoredFiles: number; recoveryId: string }> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("快照 ID 无效");
    const snapshot = JSON.parse(await fs.readFile(path.join(this.root, `${id}.json`), "utf8")) as WorkspaceSnapshot;
    if (snapshot.cwd !== path.resolve(this.cwd)) throw new Error("快照不属于当前项目");
    const targets = await Promise.all(Object.entries(snapshot.files).map(async ([name, digest]) => {
      if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("快照内容 ID 无效");
      const target = resolveWorkspacePath(this.cwd, name);
      const content = await fs.readFile(path.join(this.root, "objects", digest));
      if (hash(content) !== digest) throw new Error("快照完整性检查失败");
      return { target, content };
    }));
    const recovery = await this.create("恢复前自动备份");
    for (const name of Object.keys(recovery.files)) {
      if (!Object.hasOwn(snapshot.files, name)) await fs.unlink(resolveWorkspacePath(this.cwd, name));
    }
    for (const { target, content } of targets) { await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, content); }
    return { restoredFiles: targets.length, recoveryId: recovery.id };
  }
}
