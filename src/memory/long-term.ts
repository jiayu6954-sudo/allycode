/**
 * Innovation 7: Self-Evolving Long-Term Memory
 *
 * 设计哲学：
 * - 记忆是"提炼"而非"存储"——不是把对话存档，而是萃取出有价值的知识
 * - 三层记忆分离：用户画像 / 项目上下文 / 项目学习
 * - 每次会话后自动进化，越用越聪明
 * - 完全本地，无隐私风险（~/.devai/memory/）
 *
 * 目录结构：
 *   ~/.devai/memory/
 *     ├── user.md                          ← 用户画像（全局，跨项目）
 *     └── projects/
 *         └── {project-fingerprint}/
 *             ├── context.md               ← 项目是什么、技术栈、架构
 *             ├── decisions.md             ← 重大技术决策
 *             └── learnings.md             ← 踩过的坑、有效的解法
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { logger } from "../utils/logger.js";
import { MEMORY_DIR } from "../config/settings.js";
import { stableProjectFingerprint } from "../storage/agent-database.js";
import type { ConversationMessage } from "../types/agent.js";
import type { AIProvider } from "../providers/interface.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const MEMORY_ROOT = MEMORY_DIR;
const EXTRACTION_MAX_TOKENS = 1200;
// Minimum conversation length before attempting extraction (avoid trivial sessions)
const MIN_MESSAGES_FOR_EXTRACTION = 4;
// Max chars of conversation fed to extractor (cost control)
const MAX_CONVERSATION_CHARS = 12_000;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LongTermMemory {
  /** Global user profile (preferences, style, expertise) */
  user: string;
  /** What the project is — tech stack, architecture, purpose */
  projectContext: string;
  /** Why key decisions were made */
  projectDecisions: string;
  /** Patterns discovered, bugs fixed, effective strategies */
  projectLearnings: string;
}

export interface MemoryPaths {
  userFile: string;
  projectDir: string;
  contextFile: string;
  decisionsFile: string;
  learningsFile: string;
  legacyProjectDir: string;
  legacyContextFile: string;
  legacyDecisionsFile: string;
  legacyLearningsFile: string;
}

// ── Fingerprint ───────────────────────────────────────────────────────────────

/**
 * Deterministic fingerprint for a project directory.
 * Same path → same fingerprint → same memory bucket.
 */
function projectFingerprint(projectPath: string): string {
  return stableProjectFingerprint(projectPath);
}

function getMemoryPaths(projectPath: string): MemoryPaths {
  const fp = projectFingerprint(projectPath);
  const legacyFp = crypto
    .createHash("sha1")
    .update(path.resolve(projectPath).toLowerCase())
    .digest("hex")
    .slice(0, 12);
  const projectDir = path.join(MEMORY_ROOT, "projects", fp);
  const legacyProjectDir = path.join(MEMORY_ROOT, "projects", legacyFp);
  return {
    userFile:      path.join(MEMORY_ROOT, "user.md"),
    projectDir,
    contextFile:   path.join(projectDir, "context.md"),
    decisionsFile: path.join(projectDir, "decisions.md"),
    learningsFile: path.join(projectDir, "learnings.md"),
    legacyProjectDir,
    legacyContextFile: path.join(legacyProjectDir, "context.md"),
    legacyDecisionsFile: path.join(legacyProjectDir, "decisions.md"),
    legacyLearningsFile: path.join(legacyProjectDir, "learnings.md"),
  };
}

// ── Read ──────────────────────────────────────────────────────────────────────

async function readFile(filePath: string): Promise<string> {
  try {
    return (await fs.readFile(filePath, "utf-8")).trim();
  } catch {
    return "";
  }
}

async function readFileWithFallback(primary: string, legacy: string): Promise<string> {
  const current = await readFile(primary);
  return current || (primary === legacy ? "" : readFile(legacy));
}

/**
 * Load all long-term memory for a given project.
 * Returns empty strings for memory that doesn't exist yet.
 */
export async function loadLongTermMemory(projectPath: string): Promise<LongTermMemory> {
  const paths = getMemoryPaths(projectPath);
  const [user, projectContext, projectDecisions, projectLearnings] = await Promise.all([
    readFile(paths.userFile),
    readFileWithFallback(paths.contextFile, paths.legacyContextFile),
    readFileWithFallback(paths.decisionsFile, paths.legacyDecisionsFile),
    readFileWithFallback(paths.learningsFile, paths.legacyLearningsFile),
  ]);

  logger.debug("memory.load", {
    project: projectFingerprint(projectPath),
    hasUser: !!user,
    hasContext: !!projectContext,
    hasDecisions: !!projectDecisions,
    hasLearnings: !!projectLearnings,
  });

  return { user, projectContext, projectDecisions, projectLearnings };
}

/**
 * True if any long-term memory exists for this project.
 */
export async function hasLongTermMemory(projectPath: string): Promise<boolean> {
  const mem = await loadLongTermMemory(projectPath);
  return !!(mem.user || mem.projectContext || mem.projectDecisions || mem.projectLearnings);
}

// ── Format for system prompt ──────────────────────────────────────────────────

/**
 * Format loaded memory into a system prompt section.
 * Returns null when no memory exists (first run).
 */
export function formatMemoryForPrompt(mem: LongTermMemory, projectPath: string): string | null {
  const parts: string[] = [];

  if (mem.user) {
    parts.push(`### About this user\n${mem.user}`);
  }
  if (mem.projectContext) {
    parts.push(`### Project overview\n${mem.projectContext}`);
  }
  if (mem.projectDecisions) {
    parts.push(`### Key technical decisions\n${mem.projectDecisions}`);
  }
  if (mem.projectLearnings) {
    parts.push(`### What we've learned\n${mem.projectLearnings}`);
  }

  if (parts.length === 0) return null;

  const projectName = path.basename(projectPath);
  return `## Long-term memory (${projectName})\n\nThe following was distilled from previous sessions. Use it to give more informed, personalised responses.\n\n${parts.join("\n\n")}`;
}

// ── Extract ───────────────────────────────────────────────────────────────────

/**
 * Serialise conversation messages to a compact string for the extractor.
 */
function serializeConversation(messages: ConversationMessage[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    const role = msg.role === "user" ? "User" : "Assistant";
    const content =
      typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
        ? msg.content
            .map((b) => {
              if (typeof b === "string") return b;
              if ("text" in b && typeof (b as { text: string }).text === "string") return (b as { text: string }).text;
              if ("type" in b && (b as { type: string }).type === "tool_result") return "[tool result]";
              if ("type" in b && (b as { type: string }).type === "tool_use") {
                const tb = b as { type: string; name: string; input: unknown };
                return `[tool: ${tb.name}]`;
              }
              return "";
            })
            .filter(Boolean)
            .join(" ")
        : "";
    if (content.trim()) lines.push(`${role}: ${content.trim()}`);
  }
  const full = lines.join("\n");
  return full.length > MAX_CONVERSATION_CHARS
    ? full.slice(full.length - MAX_CONVERSATION_CHARS)
    : full;
}

const EXTRACTION_SYSTEM = `You are a memory distillation engine for an AI coding assistant called AllyCode.
Your job: analyse a conversation and extract durable knowledge worth remembering across future sessions.
Extract only facts that will remain relevant in future sessions. Skip ephemeral details (specific variable values, exact file content, one-off commands).
Be concise — bullet points preferred. Each bullet max 1 sentence.
Return ONLY valid JSON matching the schema. No explanation, no markdown, just JSON.`;

const EXTRACTION_SCHEMA = `{
  "user": "string — observations about this developer: skills, preferences, working style, things they care about. Empty string if nothing new learned.",
  "projectContext": "string — what this project is, its purpose, tech stack, key architecture. Empty string if nothing new learned.",
  "projectDecisions": "string — why important technical decisions were made (e.g. 'uses Zod for validation because runtime safety is required'). Empty string if nothing new learned.",
  "projectLearnings": "string — bugs fixed, gotchas discovered, patterns that work well, things to avoid. Empty string if nothing new learned."
}`;

interface ExtractionResult {
  user: string;
  projectContext: string;
  projectDecisions: string;
  projectLearnings: string;
}

async function extractFromConversation(
  conversation: string,
  existingMemory: LongTermMemory,
  provider: AIProvider,
  model: string,
): Promise<ExtractionResult | null> {
  const existingSummary = [
    existingMemory.user && `Existing user memory:\n${existingMemory.user}`,
    existingMemory.projectContext && `Existing project context:\n${existingMemory.projectContext}`,
    existingMemory.projectDecisions && `Existing decisions:\n${existingMemory.projectDecisions}`,
    existingMemory.projectLearnings && `Existing learnings:\n${existingMemory.projectLearnings}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const userPrompt = `${existingSummary ? `## Existing memory (do not repeat, only add new)\n${existingSummary}\n\n` : ""}## Conversation to analyse\n${conversation}\n\n## Output schema\n${EXTRACTION_SCHEMA}\n\nExtract new knowledge. Return JSON only.`;

  try {
    const handle = provider.stream({
      model,
      maxTokens: EXTRACTION_MAX_TOKENS,
      systemPrompt: EXTRACTION_SYSTEM,
      messages: [{ role: "user", content: userPrompt }],
      tools: [],
    });
    const msg = await handle.finalMessage();
    const textBlock = msg.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") return null;
    const cleaned = textBlock.text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    return JSON.parse(cleaned) as ExtractionResult;
  } catch (err) {
    logger.warn("memory.extract.failed", err);
    return null;
  }
}

// ── Merge ─────────────────────────────────────────────────────────────────────

/**
 * Merge new extracted knowledge into existing memory.
 * Appends non-empty new content with a blank line separator.
 */
function mergeMemoryField(existing: string, newContent: string): string {
  if (!newContent.trim()) return existing;
  if (!existing.trim()) return newContent.trim();
  return `${existing.trimEnd()}\n\n${newContent.trim()}`;
}

// ── Write ─────────────────────────────────────────────────────────────────────

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function writeIfNonEmpty(filePath: string, content: string): Promise<void> {
  if (!content.trim()) return;
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content.trimEnd() + "\n", "utf-8");
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Main entry point: called after each session to extract and persist new knowledge.
 *
 * @param projectPath  Absolute path to the project directory
 * @param messages     Full conversation history for this session
 * @param anthropicKey Anthropic API key (extraction always uses Haiku, costs ~$0.0001)
 * @param enabled      Whether memory extraction is enabled (from settings.memory.enabled)
 * @returns true if any new memory was written
 */
export async function extractAndSaveMemory(
  projectPath: string,
  messages: ConversationMessage[],
  provider: AIProvider,
  model: string,
  enabled = true
): Promise<boolean> {
  if (!enabled) {
    logger.debug("memory.extract.disabled");
    return false;
  }
  if (messages.length < MIN_MESSAGES_FOR_EXTRACTION) {
    logger.debug("memory.extract.skip_too_short", { count: messages.length });
    return false;
  }

  const paths = getMemoryPaths(projectPath);
  const existing = await loadLongTermMemory(projectPath);
  const conversation = serializeConversation(messages);

  logger.debug("memory.extract.start", { chars: conversation.length });

  const extracted = await extractFromConversation(conversation, existing, provider, model);
  if (!extracted) return false;

  const merged: LongTermMemory = {
    user:              mergeMemoryField(existing.user, extracted.user),
    projectContext:    mergeMemoryField(existing.projectContext, extracted.projectContext),
    projectDecisions:  mergeMemoryField(existing.projectDecisions, extracted.projectDecisions),
    projectLearnings:  mergeMemoryField(existing.projectLearnings, extracted.projectLearnings),
  };

  // Only write files that changed
  const changed =
    merged.user !== existing.user ||
    merged.projectContext !== existing.projectContext ||
    merged.projectDecisions !== existing.projectDecisions ||
    merged.projectLearnings !== existing.projectLearnings;

  if (!changed) {
    logger.debug("memory.extract.no_new_knowledge");
    return false;
  }

  await Promise.all([
    writeIfNonEmpty(paths.userFile, merged.user),
    writeIfNonEmpty(paths.contextFile, merged.projectContext),
    writeIfNonEmpty(paths.decisionsFile, merged.projectDecisions),
    writeIfNonEmpty(paths.learningsFile, merged.projectLearnings),
  ]);

  logger.debug("memory.extract.saved", {
    project: projectFingerprint(projectPath),
    userChanged: merged.user !== existing.user,
    contextChanged: merged.projectContext !== existing.projectContext,
    decisionsChanged: merged.projectDecisions !== existing.projectDecisions,
    learningsChanged: merged.projectLearnings !== existing.projectLearnings,
  });

  return true;
}

/**
 * Clear all memory for a specific project (useful for testing or fresh start).
 */
export async function clearProjectMemory(projectPath: string): Promise<void> {
  const paths = getMemoryPaths(projectPath);
  await Promise.allSettled([
    fs.rm(paths.projectDir, { recursive: true, force: true }),
    paths.legacyProjectDir === paths.projectDir
      ? Promise.resolve()
      : fs.rm(paths.legacyProjectDir, { recursive: true, force: true }),
  ]);
  logger.info("memory.cleared", { project: projectFingerprint(projectPath) });
}

/**
 * Clear user-level memory.
 */
export async function clearUserMemory(): Promise<void> {
  const userFile = path.join(MEMORY_ROOT, "user.md");
  await fs.rm(userFile, { force: true });
  logger.info("memory.user_cleared");
}

/**
 * Return the memory directory path (for display / devai memory show).
 */
export function memoryRoot(): string {
  return MEMORY_ROOT;
}
