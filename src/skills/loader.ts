/**
 * I023: Skills Framework — reusable task workflow definitions
 *
 * DeerFlow-2.0 inspiration: DeerFlow used Markdown-based Skill files to define
 * domain-specific workflows (research, report generation, slide creation).
 * This brings the same composable-workflow concept to AllyCode's coding context.
 *
 * Skills live in ~/.allycode/skills/*.md
 * Each file is a plain Markdown document. Frontmatter (YAML between --- delimiters)
 * can carry trigger keywords and metadata. The file body is the workflow instruction.
 *
 * Example skill file (~/.allycode/skills/whitepaper.md):
 * ---
 * name: Whitepaper Generation
 * triggers: [whitepaper, white paper, 白皮书, technical report, 技术报告]
 * ---
 * When generating a whitepaper:
 * 1. Announce section outline first (titles only, one message)
 * 2. Write each section with file_write — never truncate or simplify
 * 3. ...
 *
 * Skills are:
 *   - Auto-loaded at session start
 *   - Injected into the system prompt as a dedicated section
 *   - Matched by keyword presence in the user's first message (optional)
 *   - Editable by users to capture team-specific best practices
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { logger } from "../utils/logger.js";

export interface Skill {
  name: string;
  triggers: string[];
  body: string;
  filePath: string;
}

const SKILLS_DIR = path.join(
  process.env["ALLYCODE_DATA_DIR"] ?? path.join(os.homedir(), ".allycode"),
  "skills",
);

/** Parse minimal YAML-ish frontmatter (--- ... ---) from a Markdown file. */
function parseFrontmatter(content: string): { meta: Record<string, unknown>; body: string } {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!fmMatch) return { meta: {}, body: content };

  const yamlBlock = fmMatch[1] ?? "";
  const body = (fmMatch[2] ?? "").trim();
  const meta: Record<string, unknown> = {};

  for (const line of yamlBlock.split(/\r?\n/)) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const raw = line.slice(colonIdx + 1).trim();

    // Parse array: [a, b, c] or plain string
    if (raw.startsWith("[") && raw.endsWith("]")) {
      meta[key] = raw
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else {
      meta[key] = raw.replace(/^["']|["']$/g, "");
    }
  }

  return { meta, body };
}

/** Load all skill files from ~/.allycode/skills/ */
export function loadSkills(): Skill[] {
  if (!fs.existsSync(SKILLS_DIR)) return [];

  const skills: Skill[] = [];
  let files: string[];
  try {
    files = fs.readdirSync(SKILLS_DIR).filter((f) => f.endsWith(".md"));
  } catch (err) {
    logger.warn("skills.read_dir_failed", { error: String(err) });
    return [];
  }

  for (const file of files) {
    const filePath = path.join(SKILLS_DIR, file);
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const { meta, body } = parseFrontmatter(content);

      if (!body.trim()) continue; // skip empty skill files

      const rawTriggers = meta["triggers"];
      const triggers: string[] = Array.isArray(rawTriggers)
        ? (rawTriggers as string[])
        : typeof rawTriggers === "string"
          ? [rawTriggers]
          : [];

      const name =
        typeof meta["name"] === "string"
          ? meta["name"]
          : path.basename(file, ".md");

      skills.push({ name, triggers, body, filePath });
      logger.debug("skills.loaded", { name, triggers: triggers.length, file });
    } catch (err) {
      logger.warn("skills.load_failed", { file, error: String(err) });
    }
  }

  logger.info("skills.ready", { count: skills.length, dir: SKILLS_DIR });
  return skills;
}

/**
 * Filter skills that are relevant to the user's message.
 * If a skill has no triggers, it is always included (global skill).
 * If it has triggers, include it when at least one trigger matches.
 */
export function matchSkills(skills: Skill[], userMessage: string): Skill[] {
  const lower = userMessage.toLowerCase();
  return skills.filter((s) => {
    if (s.triggers.length === 0) return true; // global skill
    return s.triggers.some((t) => lower.includes(t.toLowerCase()));
  });
}

/**
 * Format matched skills for injection into the system prompt.
 * Returns empty string if no skills loaded.
 */
export function formatSkillsForPrompt(skills: Skill[]): string {
  if (skills.length === 0) return "";

  const sections = skills.map((s) => {
    const header = `### Skill: ${s.name}`;
    return `${header}\n${s.body}`;
  });

  return `# Active Skills (user-defined workflow protocols)
${sections.join("\n\n")}`;
}

/**
 * Write a default set of skill files on first run if skills dir is empty.
 * Gives users a working starting point they can customise.
 */
export function initDefaultSkills(): void {
  if (fs.existsSync(SKILLS_DIR)) {
    const existing = fs.readdirSync(SKILLS_DIR).filter((f) => f.endsWith(".md"));
    if (existing.length > 0) return; // don't overwrite user's skills
  } else {
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
  }

  const defaults: Array<{ file: string; content: string }> = [
    {
      file: "whitepaper.md",
      content: `---
name: Whitepaper / Long-form Document Generation
triggers: [whitepaper, white paper, 白皮书, technical report, 技术报告, specification, 规格书, full report]
---
When generating a whitepaper, long-form technical report, or specification document:
1. **Announce section outline first** — output chapter titles only (one concise message). Wait for implicit or explicit approval.
2. **Write section by section** — use file_write for each section. Never compress or truncate content.
3. **Never offer a simplified version** — if output is cut off, continue writing the next section in a follow-up file_write call.
4. **Forbidden phrases**: "the file is too large", "here is a condensed version", "due to length constraints".
5. After all sections are written, confirm completion with a one-line summary.
`,
    },
    {
      file: "debug-workflow.md",
      content: `---
name: Debugging Workflow
triggers: [debug, fix bug, 调试, 报错, error, exception, not working, broken]
---
When diagnosing a bug or error:
1. Read the error message and stack trace carefully before touching any code.
2. Identify the exact file and line number — use file_read to see the context.
3. Form ONE hypothesis about the root cause before attempting a fix.
4. Apply the minimal fix — do not refactor surrounding code.
5. Verify the fix by running the relevant test or command.
6. If the fix introduces a new error, revert and re-diagnose from step 1.
`,
    },
    {
      file: "feature-implementation.md",
      content: `---
name: Feature Implementation Protocol
triggers: [implement, add feature, build, create, 实现, 开发, 新增功能]
---
When implementing a new feature:
1. Read CLAUDE.md (if present) to understand project conventions.
2. Read at least 2-3 existing similar files to learn the project's patterns before writing new code.
3. Outline the implementation plan in a single message — files to create/modify, key interfaces, data flow.
4. Get implicit or explicit confirmation before writing code.
5. Implement incrementally — write core logic first, then tests, then wiring.
6. Do not add unasked-for features, extra error handling, or speculative abstractions.
`,
    },
  ];

  for (const { file, content } of defaults) {
    try {
      fs.writeFileSync(path.join(SKILLS_DIR, file), content, "utf-8");
    } catch (err) {
      logger.warn("skills.init_default_failed", { file, error: String(err) });
    }
  }

  logger.info("skills.defaults_created", { dir: SKILLS_DIR, count: defaults.length });
}
