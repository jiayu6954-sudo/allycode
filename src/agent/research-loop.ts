/**
 * I024: Sub-Agent Research Loop
 *
 * DeerFlow-2.0 inspiration: Researcher Sub-Agent runs in isolated context,
 * uses only search+fetch tools, returns a structured summary to the main agent.
 *
 * Key properties:
 * - Isolated conversation context (doesn't pollute main chat history)
 * - Restricted tool set: web_search + web_fetch only
 * - Auto-approve all tools (no user prompts during research)
 * - Stops naturally when AI outputs [[RESEARCH_COMPLETE]] or hits maxIterations
 * - Returns structured Markdown summary as tool_result to main agent
 */

import { runAgentLoop } from "./loop.js";
import { ToolRegistry } from "../tools/registry.js";
import { PermissionManager } from "../permissions/manager.js";
import { logger } from "../utils/logger.js";
import type { AIProvider } from "../providers/index.js";
import type { SearchConfig } from "../tools/web-search.js";
import type { ConversationMessage } from "../types/agent.js";
import type { DevAISettings } from "../types/config.js";

// ── Research system prompt ────────────────────────────────────────────────────

const RESEARCH_SYSTEM_PROMPT = `You are a Research Agent. Your ONLY purpose is to gather accurate, comprehensive information for the given research query.

# Available tools
- web_search: search for relevant sources
- web_fetch: read full content of a specific URL

# Research strategy
1. Start with 1-2 web_search calls to discover relevant sources
2. web_fetch the most relevant URLs to read full content
3. Cross-reference multiple sources for accuracy
4. When you have gathered enough information, output your final summary

# Completion format
When research is complete, output EXACTLY this structure (the marker is required):

[[RESEARCH_COMPLETE]]
## Summary
<comprehensive answer to the research query — 3-8 paragraphs>

## Key Facts
- <specific fact 1>
- <specific fact 2>
...

## Sources
- [Page Title](URL)
...

# Rules
- ONLY use web_search and web_fetch — no file operations, no bash
- NEVER fabricate information; if you can't find something, say so explicitly
- Stop when you have sufficient information — don't over-search
- The [[RESEARCH_COMPLETE]] marker MUST appear at the very start of your final message`;

const RESEARCH_COMPLETE_MARKER = "[[RESEARCH_COMPLETE]]";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ResearchOptions {
  query: string;
  depth?: "basic" | "deep";   // basic=6 iterations, deep=15
  provider: AIProvider;
  model: string;
  maxTokens: number;
  searchConfig: SearchConfig;
  cwd: string;
  onProgress?: (msg: string) => void;
  signal?: AbortSignal;
}

export interface ResearchResult {
  summary: string;
  searchCount: number;
  fetchCount: number;
}

// ── Minimal settings for research sub-loop ───────────────────────────────────

function makeResearchSettings(searchConfig: SearchConfig): DevAISettings {
  return {
    provider: "anthropic",
    model: "unused",
    maxTokens: 8192,
    tokenBudget: { warningThreshold: 80 },
    defaultPermissions: {
      bash: "deny",
      file_write: "deny",
      file_edit: "deny",
      file_read: "deny",
      glob: "deny",
      grep: "deny",
      web_fetch: "auto",
      web_search: "auto",
      session_search: "deny",
      git_commit: "deny",
      spawn_research: "deny",
    },
    customRules: [],
    ui: { theme: "auto", showThinking: false, showTokenCount: false, showCost: false },
    context: { maxHistoryMessages: 20, compactionThreshold: 80, claudeMdPaths: [] },
    memory: {
      enabled: false,
      maxConversationChars: 4000,
      semanticRetrieval: false,
      embeddingModel: "nomic-embed-text",
      topK: 5,
      similarityThreshold: 0.25,
    },
    localModel: { autoDiscover: false, useForMemory: false, memoryModel: "qwen2.5:7b" },
    sandbox: {
      enabled: false,
      level: "standard",
      image: "node:20-slim",
      timeoutMs: 30_000,
      maxMemoryMb: 512,
      allowNetwork: true,
      persistent: true,
      pidsLimit: 256,
      fallbackToHost: false,
    },
    mcpServers: [],
    search: {
      defaultProvider: (searchConfig.defaultProvider as "auto") ?? "auto",
      searxngUrl: searchConfig.searxngUrl,
      tavilyApiKey: searchConfig.tavilyApiKey,
      braveApiKey: searchConfig.braveApiKey,
      serperApiKey: searchConfig.serperApiKey,
    },
    hooks: { preToolUse: [], postToolUse: [] },
    github: {},
    providerBaseUrls: {},
    onboarding: { completed: true, region: "cn" },
    updates: { enabled: true, channel: "alpha", automaticDownload: false },
  } as DevAISettings;
}

// ── Extract summary from conversation history ────────────────────────────────

function extractSummary(history: ConversationMessage[]): string {
  // Scan assistant messages from newest to oldest for [[RESEARCH_COMPLETE]]
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (!msg || msg.role !== "assistant") continue;
    const blocks = Array.isArray(msg.content) ? msg.content : [msg.content];
    for (const block of blocks) {
      if (typeof block === "object" && block !== null && "text" in block) {
        const text = (block as { text: string }).text;
        const idx = text.indexOf(RESEARCH_COMPLETE_MARKER);
        if (idx !== -1) {
          return text.slice(idx + RESEARCH_COMPLETE_MARKER.length).trim();
        }
      }
    }
  }
  // Fallback: return last assistant text block
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (!msg || msg.role !== "assistant") continue;
    const blocks = Array.isArray(msg.content) ? msg.content : [msg.content];
    for (const block of blocks) {
      if (typeof block === "object" && block !== null && "text" in block) {
        const t = ((block as { text: string }).text ?? "").trim();
        if (t) return t;
      }
    }
  }
  return "(no research summary produced)";
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function runResearchLoop(opts: ResearchOptions): Promise<ResearchResult> {
  const maxIter = opts.depth === "deep" ? 15 : 6;
  let searchCount = 0;
  let fetchCount = 0;

  logger.info("research_loop.start", {
    query: opts.query.slice(0, 80),
    depth: opts.depth ?? "basic",
    maxIter,
  });
  opts.onProgress?.("Research starting…");

  // Restricted registry: only web_search + web_fetch
  const researchSettings = makeResearchSettings(opts.searchConfig);
  const restrictedRegistry = new ToolRegistry(
    opts.cwd,
    undefined,        // no MCP in research sub-loop
    undefined,        // no Docker sandbox
    opts.searchConfig,
    undefined,        // no researchRunner (no nested sub-agents)
    new Set(["web_search", "web_fetch"]),
  );

  // Auto-approve all tools — no user prompts during background research
  const permMgr = new PermissionManager(researchSettings, async () => "allow");

  const history: ConversationMessage[] = [
    { role: "user", content: `Research query: ${opts.query}` },
  ];

  const loopResult = await runAgentLoop(
    opts.provider,
    {
      model: opts.model,
      maxTokens: Math.min(opts.maxTokens, 8192),
      systemPrompt: RESEARCH_SYSTEM_PROMPT,
      conversationHistory: history,
      maxIterations: maxIter,
      onEvent: (event) => {
        if (event.type === "tool_start") {
          if (event.toolName === "web_search") {
            searchCount++;
            const q = (event.input as { query?: string }).query ?? "";
            opts.onProgress?.(`Searching: "${q.slice(0, 50)}"`);
          }
          if (event.toolName === "web_fetch") {
            fetchCount++;
            const url = (event.input as { url?: string }).url ?? "";
            opts.onProgress?.(`Reading: ${url.slice(0, 60)}`);
          }
        }
      },
      signal: opts.signal,
    },
    restrictedRegistry,
    permMgr,
  );

  const summary = extractSummary(loopResult.updatedHistory);
  logger.info("research_loop.done", { searches: searchCount, fetches: fetchCount });
  opts.onProgress?.(`Complete — ${searchCount} searches, ${fetchCount} pages read`);

  return { summary, searchCount, fetchCount };
}
