/**
 * I009: Slash Command System
 *
 * Provides an extensible registry of /command handlers that run inside the
 * REPL without consuming an LLM API call. Mirrors Claude Code's commands/
 * directory pattern but implemented as a lightweight registry for devai.
 *
 * Commands are intercepted in useAgentLoop before the message is sent to the
 * provider, so they always respond instantly.
 *
 * Design principles (learned from Claude Code source):
 *  - Each command is a pure function: (args, context) → SlashResult
 *  - Commands can mutate session state via the context callbacks
 *  - Unknown /xyz commands fall through to the LLM (not an error)
 *  - Tab-completion list is derived from the registry automatically
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { TokenUsage } from "../types/agent.js";
import { writeClaudeMd } from "../memory/claude-md.js";
import { loadSkills } from "../skills/loader.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface SlashContext {
  /** Current conversation history length (for display) */
  messageCount: number;
  /** Cumulative token usage for this session */
  usage: TokenUsage;
  /** Current model identifier */
  model: string;
  /** Current provider name */
  provider: string;
  /** Working directory */
  cwd: string;
  /** Session ID (short form for display) */
  sessionId?: string;
  /** Loaded long-term memory entries (for /memory) */
  memoryEntries?: string[];
  /** Clears the conversation history */
  clearHistory: () => void;
  /** Triggers a manual compact */
  triggerCompact: () => void;
}

export type SlashResult =
  | { type: "message"; text: string }         // display as system message
  | { type: "clear" }                         // handled by clearHistory()
  | { type: "compact" }                       // trigger compaction
  | { type: "rewrite"; input: string }        // replace user input before sending to LLM (I021)
  | { type: "passthrough" };                  // not a command — send to LLM

// ── Registry ──────────────────────────────────────────────────────────────

type CommandHandler = (args: string, ctx: SlashContext) => SlashResult;

interface CommandDef {
  name: string;
  description: string;
  handler: CommandHandler;
}

const COMMANDS: CommandDef[] = [
  {
    name: "clear",
    description: "Clear conversation history and start a fresh session",
    handler: (_args, ctx) => {
      ctx.clearHistory();
      return { type: "clear" };
    },
  },
  {
    name: "compact",
    description: "Manually compress conversation context to free up space",
    handler: (_args, ctx) => {
      ctx.triggerCompact();
      return { type: "compact" };
    },
  },
  {
    name: "cost",
    description: "Show token usage and estimated cost for this session",
    handler: (_args, ctx) => {
      const { usage, sessionId, model, provider } = ctx;
      const totalIn = usage.inputTokens + usage.cacheReadTokens;
      const totalOut = usage.outputTokens;
      const totalTok = totalIn + totalOut;

      const lines: string[] = [
        `── Session Cost Report ────────────────`,
        `Model:     ${model}`,
        `Provider:  ${provider}`,
        sessionId ? `Session:   #${sessionId.slice(0, 8)}` : "",
        ``,
        `Input:     ${fmtTokens(usage.inputTokens)} tokens`,
        usage.cacheReadTokens > 0
          ? `Cache hit: ${fmtTokens(usage.cacheReadTokens)} tokens (saved ~${fmtCost(usage.cacheReadTokens * 0.0000003)})`
          : "",
        `Output:    ${fmtTokens(usage.outputTokens)} tokens`,
        `Total:     ${fmtTokens(totalTok)} tokens`,
        ``,
        `Est. cost: ${fmtCost(usage.estimatedCostUsd)}`,
        `──────────────────────────────────────`,
      ].filter(Boolean);

      return { type: "message", text: lines.join("\n") };
    },
  },
  {
    name: "help",
    description: "Show available slash commands and keyboard shortcuts",
    handler: (_args, _ctx) => {
      const cmdLines = COMMANDS.map(
        (c) => `  /${c.name.padEnd(10)} — ${c.description}`
      ).join("\n");

      return {
        type: "message",
        text: [
          `── AllyCode Slash Commands ───────────────`,
          cmdLines,
          ``,
          `── Keyboard Shortcuts ─────────────────`,
          `  Ctrl+C          — abort current task (or exit when idle)`,
          `  PgUp / PgDn     — scroll conversation`,
          `  ↑ / ↓           — cycle input history (when input is empty)`,
          `  Ctrl+J          — insert newline without submitting`,
          `  Ctrl+U          — clear current input`,
          `──────────────────────────────────────`,
        ].join("\n"),
      };
    },
  },
  {
    name: "model",
    description: "Show current model and provider information",
    handler: (_args, ctx) => {
      return {
        type: "message",
        text: [
          `── Current Model ──────────────────────`,
          `Model:    ${ctx.model}`,
          `Provider: ${ctx.provider}`,
          `CWD:      ${ctx.cwd}`,
          `──────────────────────────────────────`,
        ].join("\n"),
      };
    },
  },
  {
    name: "memory",
    description: "Show loaded long-term memory entries for this project",
    handler: (_args, ctx) => {
      const entries = ctx.memoryEntries ?? [];
      if (entries.length === 0) {
        return {
          type: "message",
          text: "── Memory ─────────────────────────────\n  (no long-term memory loaded for this project)\n──────────────────────────────────────",
        };
      }
      return {
        type: "message",
        text: [
          `── Long-term Memory (${entries.length} entries) ──────`,
          ...entries.map((e, i) => `  ${i + 1}. ${e}`),
          `──────────────────────────────────────`,
          `  Tip: AllyCode automatically updates memory at session end.`,
        ].join("\n"),
      };
    },
  },
  {
    name: "diag",
    description: "Show recent errors from ~/.allycode/debug.log (last 30 WARN/ERROR lines)",
    handler: (_args, _ctx) => {
      const dataDir = process.env["ALLYCODE_DATA_DIR"] ?? path.join(os.homedir(), ".allycode");
      const logFile = path.join(dataDir, "debug.log");
      try {
        if (!fs.existsSync(logFile)) {
          return { type: "message", text: "── Diagnostics ────────────────────────\n  No debug.log found — no errors recorded.\n──────────────────────────────────────" };
        }
        const all = fs.readFileSync(logFile, "utf-8").split("\n");
        const errors = all
          .filter((l) => l.includes("[WARN") || l.includes("[ERROR"))
          .slice(-30);
        if (errors.length === 0) {
          return { type: "message", text: "── Diagnostics ────────────────────────\n  No warnings or errors in recent log.\n──────────────────────────────────────" };
        }
        // Compact format: strip JSON payload to keep lines readable
        const compact = errors.map((l) => {
          const m = l.match(/\[(WARN|ERROR)\s+([0-9T:.Z-]+)\]\s+(\S+)/);
          if (!m) return l.slice(0, 120);
          return `${m[1]} ${m[2]!.slice(11, 19)} ${m[3]}`;
        });
        return {
          type: "message",
          text: [
            `── Recent Errors (${errors.length}) ─────────────────`,
            ...compact,
            `──────────────────────────────────────`,
            `  Full log: ${logFile}`,
          ].join("\n"),
        };
      } catch (e) {
        return { type: "message", text: `── Diagnostics ────────────────────────\n  Failed to read log: ${String(e)}\n──────────────────────────────────────` };
      }
    },
  },
  {
    name: "init",
    description: "Scan current project and create CLAUDE.md with project context for persistent memory",
    handler: (_args, ctx) => {
      // Scan project structure and write a CLAUDE.md scaffold.
      // The LLM will then be asked (via the returned message) to fill in the content properly.
      const cwd = ctx.cwd;
      const files: string[] = [];
      try {
        // Collect top-level items and key config files
        const entries = fs.readdirSync(cwd, { withFileTypes: true });
        for (const e of entries.slice(0, 40)) {
          files.push(e.isDirectory() ? `${e.name}/` : e.name);
        }
      } catch { /* ignore */ }

      const scaffold = [
        `# Project Context (CLAUDE.md)`,
        `<!-- Auto-scaffolded by /init — fill in details or ask AllyCode to complete this -->`,
        ``,
        `## Project`,
        `<!-- What is this project? What does it do? -->`,
        ``,
        `## Tech Stack`,
        `<!-- Languages, frameworks, databases, key libraries -->`,
        ``,
        `## Architecture`,
        `<!-- High-level structure, key components, how they interact -->`,
        ``,
        `## Key Decisions`,
        `<!-- Why was X chosen over Y? Important constraints. -->`,
        ``,
        `## Common Commands`,
        `\`\`\`bash`,
        `# build / test / start / deploy`,
        `\`\`\``,
        ``,
        `## Known Issues / Gotchas`,
        `<!-- Proxy settings, DNS config, dependency quirks, environment requirements -->`,
        ``,
        `## Delivery Standards`,
        `<!-- Quality expectations, checklist, acceptance criteria -->`,
      ].join("\n");

      try {
        // Only create if CLAUDE.md doesn't already exist
        const claudeMdPath = path.join(cwd, "CLAUDE.md");
        if (fs.existsSync(claudeMdPath)) {
          return {
            type: "message",
            text: [
              `── /init ───────────────────────────────`,
              `  CLAUDE.md already exists at:`,
              `  ${claudeMdPath}`,
              `  Use file_edit to update it, or delete it first to reinitialise.`,
              `──────────────────────────────────────`,
            ].join("\n"),
          };
        }
        void writeClaudeMd(cwd, scaffold);
        return {
          type: "message",
          text: [
            `── /init ───────────────────────────────`,
            `  Created CLAUDE.md at: ${claudeMdPath}`,
            ``,
            `  Project files detected (${files.length}):`,
            `  ${files.slice(0, 20).join("  ")}`,
            ``,
            `  Next: ask AllyCode "填写这个项目的 CLAUDE.md" and it will`,
            `  analyse the codebase and fill in all sections automatically.`,
            `  This file persists across sessions — AI will remember context.`,
            `──────────────────────────────────────`,
          ].join("\n"),
        };
      } catch (e) {
        return { type: "message", text: `── /init ────────────────────────────\n  Failed: ${String(e)}\n──────────────────────────────────` };
      }
    },
  },
  // ── I021: Plan Mode ─────────────────────────────────────────────────────
  {
    name: "plan",
    description: "Generate a structured execution plan before coding — review before any files are touched",
    handler: (args, _ctx) => {
      const task = args.trim();

      // Build a planning-focused prompt that instructs the AI to reason first,
      // produce a numbered plan, and explicitly NOT use any tools yet.
      const planningPrefix = [
        "**[PLAN MODE]** Before writing any code or using any tools, produce a detailed execution plan for the following task.",
        "",
        "Your plan must include:",
        "1. A brief restatement of the goal (1-2 sentences)",
        "2. Numbered phases with concrete steps (what files to read, create, or modify)",
        "3. Key technical decisions and tradeoffs",
        "4. Expected outcomes and verification steps",
        "",
        "Format as a numbered Markdown list. DO NOT use any tools yet.",
        "After presenting the plan, ask: '**Proceed with this plan? (reply yes / adjust X / stop)**'",
        "",
        task ? `Task: ${task}` : "(The user will describe the task in their next message — ask them to describe it now.)",
      ].join("\n");

      if (!task) {
        // No task given — display instructions and let user describe it
        return {
          type: "message",
          text: [
            "── Plan Mode ──────────────────────────────",
            "  Describe the task you want to plan:",
            "  /plan <task description>",
            "",
            "  Example: /plan build a REST API for user management with JWT auth",
            "──────────────────────────────────────────",
          ].join("\n"),
        };
      }

      // Rewrite the input so the LLM sees the planning instructions,
      // but the user still sees their original task in the UI.
      return { type: "rewrite", input: planningPrefix };
    },
  },

  // ── I023: Skill list ─────────────────────────────────────────────────────
  {
    name: "skill",
    description: "List loaded skill workflow definitions from ~/.allycode/skills/",
    handler: (_args, _ctx) => {
      const skills = loadSkills();

      if (skills.length === 0) {
        return {
          type: "message",
          text: [
            "── Skills ─────────────────────────────────",
            "  No skills loaded.",
            "",
            "  Create skill files in ~/.allycode/skills/*.md",
            "  Each file defines a reusable task workflow.",
            "  Run /init to scaffold default skills.",
            "───────────────────────────────────────────",
          ].join("\n"),
        };
      }

      const lines = skills.map((s, i) => {
        const triggers = s.triggers.length > 0 ? `  triggers: ${s.triggers.join(", ")}` : "  (global — always active)";
        return `  ${i + 1}. ${s.name}\n${triggers}`;
      });

      return {
        type: "message",
        text: [
          `── Loaded Skills (${skills.length}) ──────────────────`,
          ...lines,
          "",
          "  Skills are auto-injected into the system prompt.",
          "  Edit files in ~/.allycode/skills/ to customise.",
          "───────────────────────────────────────────",
        ].join("\n"),
      };
    },
  },

  {
    name: "status",
    description: "Show current session statistics overview",
    handler: (_args, ctx) => {
      return {
        type: "message",
        text: [
          `── Session Status ─────────────────────`,
          `Messages:  ${ctx.messageCount}`,
          `Model:     ${ctx.model}  (${ctx.provider})`,
          `Tokens:    ${fmtTokens(ctx.usage.inputTokens + ctx.usage.cacheReadTokens + ctx.usage.outputTokens)}`,
          `Cost:      ${fmtCost(ctx.usage.estimatedCostUsd)}`,
          ctx.sessionId ? `Session:   #${ctx.sessionId.slice(0, 8)}` : "",
          `──────────────────────────────────────`,
        ]
          .filter(Boolean)
          .join("\n"),
      };
    },
  },
];

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Parse and dispatch a potential slash command.
 * Returns `passthrough` if the input is not a slash command.
 */
export function handleSlashCommand(input: string, ctx: SlashContext): SlashResult {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return { type: "passthrough" };

  // Don't intercept things like //comment or paths like /usr/bin
  const afterSlash = trimmed.slice(1);
  if (!afterSlash || afterSlash.startsWith("/")) return { type: "passthrough" };

  const spaceIdx = afterSlash.indexOf(" ");
  const name = spaceIdx === -1 ? afterSlash : afterSlash.slice(0, spaceIdx);
  const args = spaceIdx === -1 ? "" : afterSlash.slice(spaceIdx + 1).trim();

  const cmd = COMMANDS.find((c) => c.name === name.toLowerCase());
  if (!cmd) {
    // Unknown command — let it reach the LLM (user might be asking about /something)
    return { type: "passthrough" };
  }

  return cmd.handler(args, ctx);
}

/** All registered command names — used for tab-completion hints in InputBar. */
export function getSlashCommandNames(): string[] {
  return COMMANDS.map((c) => c.name);
}

/** Full command definitions — used for /help rendering. */
export function getSlashCommands(): ReadonlyArray<{ name: string; description: string }> {
  return COMMANDS;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtCost(usd: number): string {
  if (usd === 0) return "$0.000";
  if (usd < 0.001) return `$${usd.toFixed(5)}`;
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}
