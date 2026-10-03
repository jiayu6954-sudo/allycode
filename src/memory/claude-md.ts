import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { logger } from "../utils/logger.js";
import { DATA_DIR } from "../config/settings.js";


const CLAUDE_MD_FILENAME = "CLAUDE.md";
const MAX_CLAUDE_MD_BYTES = 100_000;

/**
 * Discovers and loads CLAUDE.md files in priority order:
 *   1. cwd/CLAUDE.md  (most specific)
 *   2. cwd/.claude/CLAUDE.md
 *   3. Git root CLAUDE.md (walk up from cwd)
 *   4. ~/.devai/CLAUDE.md  (global user memory)
 *   5. Any extra paths from settings
 *
 * Later files in the list take precedence (bottom wins).
 */
export async function loadClaudeMd(
  cwd: string,
  extraPaths: string[] = []
): Promise<string | null> {
  const gitRoot = await findGitRoot(cwd);

  const candidatePaths = [
    path.join(DATA_DIR, CLAUDE_MD_FILENAME),
    gitRoot ? path.join(gitRoot, CLAUDE_MD_FILENAME) : null,
    path.join(cwd, ".claude", CLAUDE_MD_FILENAME),
    path.join(cwd, CLAUDE_MD_FILENAME),
    gitRoot ? path.join(gitRoot, "AGENTS.md") : null,
    path.join(cwd, "AGENTS.md"),
    ...extraPaths,
  ].filter((p): p is string => p !== null);

  // Deduplicate (resolving symlinks would be ideal but is expensive)
  const seen = new Set<string>();
  const deduped = candidatePaths.filter((p) => {
    if (seen.has(p)) return false;
    seen.add(p);
    return true;
  });

  const contents: string[] = [];

  for (const filePath of deduped) {
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > MAX_CLAUDE_MD_BYTES) {
        logger.warn("claude_md.too_large", { path: filePath, size: stat.size });
        continue;
      }
      const content = await fs.readFile(filePath, "utf-8");
      if (content.trim()) {
        contents.push(`<!-- Context from: ${filePath}; SHA256: ${createHash("sha256").update(content).digest("hex")} -->\n${content.trim()}`);
        logger.debug("claude_md.loaded", { path: filePath });
      }
    } catch {
      // File not found or unreadable — skip silently
    }
  }

  return contents.length > 0 ? contents.join("\n\n---\n\n") : null;
}

/**
 * Walk up the directory tree from cwd looking for a .git directory.
 * Returns the git root path, or null if not in a git repo.
 */
async function findGitRoot(startDir: string): Promise<string | null> {
  let dir = startDir;
  const root = path.parse(dir).root;

  while (dir !== root) {
    try {
      const gitPath = path.join(dir, ".git");
      await fs.access(gitPath);
      return dir; // Found it
    } catch {
      // Not here, go up
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // Reached filesystem root
    dir = parent;
  }

  return null;
}

/**
 * Create or update the project CLAUDE.md file.
 */
export async function writeClaudeMd(cwd: string, content: string): Promise<void> {
  const filePath = path.join(cwd, CLAUDE_MD_FILENAME);
  await fs.writeFile(filePath, content, "utf-8");
  logger.info("claude_md.written", { path: filePath });
}

/**
 * Append a note to the project CLAUDE.md.
 */
export async function appendToClaudeMd(cwd: string, note: string): Promise<void> {
  const filePath = path.join(cwd, CLAUDE_MD_FILENAME);
  let existing = "";
  try {
    existing = await fs.readFile(filePath, "utf-8");
  } catch {
    // New file
  }
  const newContent = existing
    ? `${existing.trimEnd()}\n\n${note}`
    : note;
  await fs.writeFile(filePath, newContent, "utf-8");
}
