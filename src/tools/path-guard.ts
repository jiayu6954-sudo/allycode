import fs from "node:fs";
import path from "node:path";

const INVISIBLE_PATH_CHARS = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;

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
