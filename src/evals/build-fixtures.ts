/**
 * Builds redacted replay fixtures from recorded sessions.
 *
 * A fixture must preserve the SHAPE that drives context cost — message count,
 * turn structure, tool-result sizes, thinking-text sizes, tool_use/tool_result
 * pairing — while carrying none of the content. Redaction replaces text with
 * filler of equivalent length and character class, so the estimator sees the
 * same token weight without the fixture holding source code, secrets, or paths
 * that identify a machine or a customer.
 *
 *   npm run fixtures:build -- --session <path> --name long-failed-delivery
 *   npm run fixtures:build -- --scan            # list candidate sessions
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repairBoundaries } from "../agent/history-budget.js";
import type { ConversationMessage } from "../types/agent.js";

/**
 * Cut a transcript to roughly `maxTurns` assistant turns, ending on a complete
 * tool transaction. Recorded sessions do not come in every size, so a medium
 * fixture is derived from a real long one rather than substituted by a short
 * one — the derivation is recorded in the fixture metadata.
 */
function truncateToTurns(messages: ConversationMessage[], maxTurns: number): ConversationMessage[] {
  let turns = 0;
  let cut = messages.length;
  for (const [index, message] of messages.entries()) {
    if (message.role !== "assistant") continue;
    turns++;
    if (turns >= maxTurns) { cut = index + 1; break; }
  }
  // Include the tool results answering that final assistant turn, then repair.
  while (cut < messages.length) {
    const next = messages[cut]!;
    const isToolResultOnly = next.role === "user" &&
      Array.isArray(next.content) &&
      next.content.every((block) => block.type === "tool_result");
    if (!isToolResultOnly) break;
    cut++;
  }
  return repairBoundaries(messages.slice(0, cut));
}

const FIXTURE_DIR = path.join("test", "fixtures", "token-efficiency");

/** Anything that could identify a machine, a person, or a credential. */
const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /gh[pousr]_[A-Za-z0-9]{16,}/g,
  /(?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*\S+/gi,
  /Bearer\s+[A-Za-z0-9._-]{12,}/g,
  /[A-Za-z]:\\Users\\[^\\/"'\s]+/g,
  /\/(?:home|Users)\/[^/"'\s]+/g,
];

/** Replace text with filler of the same length and character class. */
function scramble(text: string): string {
  let out = "";
  for (const ch of text) {
    if (/\s/.test(ch)) out += ch;
    else if (/[㐀-鿿]/.test(ch)) out += "文";
    else if (/[0-9]/.test(ch)) out += "0";
    else if (/[A-Z]/.test(ch)) out += "A";
    else if (/[a-z]/.test(ch)) out += "a";
    else out += ch;
  }
  return out;
}

/** Redact while preserving length; assert no secret survives. */
function redactText(text: string): string {
  let working = text;
  for (const pattern of SECRET_PATTERNS) {
    working = working.replace(pattern, (match) => "x".repeat(match.length));
  }
  return scramble(working);
}

function redactMessage(message: ConversationMessage): ConversationMessage {
  const out: ConversationMessage = { ...message };
  if (typeof message.content === "string") {
    out.content = redactText(message.content);
  } else if (Array.isArray(message.content)) {
    out.content = message.content.map((block) => {
      if (block.type === "text") return { ...block, text: redactText(block.text) };
      if (block.type === "tool_result") {
        const body = block.content;
        return {
          ...block,
          content: typeof body === "string" ? redactText(body) : body,
        };
      }
      if (block.type === "tool_use") {
        // Keep the tool name and the input's shape; scrub the values.
        return { ...block, input: redactUnknown(block.input) };
      }
      return block;
    }) as ConversationMessage["content"];
  }
  const state = message.providerState;
  if (state?.protocol === "deepseek-chat" && typeof state.reasoningContent === "string") {
    out.providerState = { ...state, reasoningContent: redactText(state.reasoningContent) };
  }
  return out;
}

function redactUnknown(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactUnknown);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) out[key] = redactUnknown(nested);
    return out;
  }
  return value;
}

/** Fail loudly rather than ship a fixture that still contains a secret. */
function assertClean(serialized: string): void {
  for (const pattern of SECRET_PATTERNS) {
    const match = serialized.match(new RegExp(pattern.source, pattern.flags));
    if (match) {
      throw new Error(`脱敏失败，仍匹配到敏感模式：${pattern.source} → ${match[0].slice(0, 40)}`);
    }
  }
}

interface FixtureMeta {
  name: string;
  klass: "short" | "medium" | "long";
  messageCount: number;
  assistantTurns: number;
  toolResultBlocks: number;
  reasoningTurns: number;
  sha256: string;
  redaction: string;
  sourceShape: { originalChars: number; fixtureChars: number };
  /** Set when the fixture was cut from a longer recording to hit a size class. */
  derivedFrom?: { originalMessageCount: number; truncatedToTurns: number };
}

function classify(assistantTurns: number): FixtureMeta["klass"] {
  if (assistantTurns < 10) return "short";
  if (assistantTurns <= 80) return "medium";
  return "long";
}

export function buildFixture(
  messages: ConversationMessage[],
  name: string,
  maxTurns?: number,
): { fixture: { messages: ConversationMessage[] }; meta: FixtureMeta } {
  const originalCount = messages.length;
  const source = maxTurns ? truncateToTurns(messages, maxTurns) : messages;
  const originalChars = JSON.stringify(source).length;
  const redacted = source.map(redactMessage);
  const fixture = { messages: redacted };
  const serialized = JSON.stringify(fixture, null, 2);
  assertClean(serialized);

  let assistantTurns = 0;
  let toolResultBlocks = 0;
  let reasoningTurns = 0;
  for (const message of redacted) {
    if (message.role === "assistant") assistantTurns++;
    if (Array.isArray(message.content)) {
      toolResultBlocks += message.content.filter((block) => block.type === "tool_result").length;
    }
    const state = message.providerState;
    if (state?.protocol === "deepseek-chat" && state.reasoningContent) reasoningTurns++;
  }

  return {
    fixture,
    meta: {
      name,
      klass: classify(assistantTurns),
      messageCount: redacted.length,
      assistantTurns,
      toolResultBlocks,
      reasoningTurns,
      sha256: crypto.createHash("sha256").update(serialized).digest("hex"),
      redaction:
        "文本按字符类等长替换（汉字→文，数字→0，大写→A，小写→a），" +
        "密钥/令牌/绝对用户路径先行整体屏蔽。保留消息结构、工具配对、长度与字符类分布。",
      sourceShape: { originalChars, fixtureChars: serialized.length },
      ...(maxTurns
        ? { derivedFrom: { originalMessageCount: originalCount, truncatedToTurns: maxTurns } }
        : {}),
    },
  };
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag?.startsWith("--")) out[flag.slice(2)] = argv[++index] ?? "true";
  }
  return out;
}

function sessionDir(): string {
  const env = process.env["ALLYCODE_DATA_DIR"]?.trim();
  return path.join(env ? path.resolve(env) : path.join(os.homedir(), ".allycode"), "sessions");
}

function scan(): void {
  const dir = sessionDir();
  if (!fs.existsSync(dir)) { console.log(`没有会话目录：${dir}`); return; }
  console.log(`会话目录：${dir}\n`);
  console.log("文件".padEnd(40) + "消息".padStart(7) + "助手轮".padStart(9) + "类别".padStart(9));
  for (const entry of fs.readdirSync(dir).filter((name) => name.endsWith(".json"))) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, entry), "utf8")) as { messages?: ConversationMessage[] };
      const messages = parsed.messages ?? [];
      const turns = messages.filter((message) => message.role === "assistant").length;
      console.log(entry.slice(0, 38).padEnd(40) + String(messages.length).padStart(7) + String(turns).padStart(9) + classify(turns).padStart(9));
    } catch { /* not a session file */ }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args["scan"]) { scan(); return; }

  const sessionPath = args["session"];
  const name = args["name"];
  if (!sessionPath || !name) {
    console.error(
      "用法：npm run fixtures:build -- --session <path> --name <fixture-name> [--maxTurns N]   |   --scan",
    );
    process.exitCode = 2;
    return;
  }

  const parsed = JSON.parse(fs.readFileSync(sessionPath, "utf8")) as { messages?: ConversationMessage[] };
  const messages = parsed.messages ?? [];
  if (messages.length === 0) throw new Error("会话为空，无法生成 fixture");

  const maxTurns = args["maxTurns"] ? Number(args["maxTurns"]) : undefined;
  const { fixture, meta } = buildFixture(messages, name, maxTurns);
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const target = path.join(FIXTURE_DIR, `${name}.json`);
  fs.writeFileSync(target, JSON.stringify(fixture, null, 2), "utf8");

  const metaPath = path.join(FIXTURE_DIR, `${name}.meta.json`);
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");

  console.log(`已生成 ${target}`);
  console.log(`  类别 ${meta.klass} · 消息 ${meta.messageCount} · 助手轮 ${meta.assistantTurns}`);
  console.log(`  工具结果块 ${meta.toolResultBlocks} · 含思维链的轮次 ${meta.reasoningTurns}`);
  console.log(`  sha256 ${meta.sha256.slice(0, 16)}…`);
  console.log(`  体积 ${meta.sourceShape.originalChars.toLocaleString()} → ${meta.sourceShape.fixtureChars.toLocaleString()} 字符`);
}

const invokedDirectly = process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
