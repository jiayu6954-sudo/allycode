import fs from "node:fs";
import path from "node:path";

const INVISIBLE_PATH_CHARS = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;

/** Drive, filesystem, and bare UNC roots are too broad for an autonomous task. */
export function isUnsafeWorkspaceRoot(workspacePath: string): boolean {
  const resolved = path.resolve(workspacePath);
  const parsed = path.parse(resolved);
  return normalizeForComparison(resolved) === normalizeForComparison(parsed.root);
}

export function assertSafeWorkspaceRoot(workspacePath: string): void {
  if (isUnsafeWorkspaceRoot(workspacePath)) {
    throw new Error(
      `为保护本机文件，不能把磁盘或文件系统根目录设为项目：${path.resolve(workspacePath)}。` +
      "请选择或新建一个具体的项目文件夹。",
    );
  }
}

/**
 * Resolve a host file-tool path and keep both its lexical and real path inside
 * the active workspace. Checking the nearest existing ancestor also blocks a
 * write through a workspace symlink that points outside the workspace.
 */
export function resolveWorkspacePath(cwd: string, requestedPath: string): string {
  const workspace = path.resolve(cwd);
  const clean = requestedPath.replace(INVISIBLE_PATH_CHARS, "").trim();
  const resolved = path.resolve(workspace, clean);
  ensureContained(workspace, resolved, requestedPath);

  const realWorkspace = fs.realpathSync.native(workspace);
  const realAncestor = fs.realpathSync.native(nearestExistingAncestor(resolved));
  ensureContained(realWorkspace, realAncestor, requestedPath, true);
  return resolved;
}

function ensureContained(
  root: string,
  candidate: string,
  requestedPath: string,
  throughSymlink = false,
): void {
  const relative = path.relative(root, candidate);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    const detail = throughSymlink ? " through a symbolic link" : "";
    throw new Error(
      `Path resolves outside the active workspace${detail}: ${requestedPath}`,
    );
  }
}

function nearestExistingAncestor(candidate: string): string {
  let current = candidate;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function normalizeForComparison(value: string): string {
  const normalized = path.normalize(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
