import { z } from "zod";

const PermissionLevelSchema = z.enum(["auto", "ask", "deny"]);

export const SettingsSchema = z.object({
  /** AI provider to use */
  provider: z
    .enum(["anthropic", "openai", "deepseek", "qwen", "groq", "gemini", "ollama", "openrouter", "moonshot", "custom"])
    .default("deepseek"),

  model: z
    .string()
    .default("deepseek-v4-pro"),

  maxTokens: z.number().int().min(1024).max(384000).default(32000),

  /** Wire protocol used for model requests. Auto selects a verified provider default. */
  providerProtocol: z
    .enum(["auto", "anthropic", "chat_completions", "responses"])
    .default("auto"),

  reasoning: z
    .object({
      /** Thinking/reasoning mode where the selected protocol supports it. */
      mode: z.enum(["auto", "enabled", "disabled"]).default("auto"),
      /** Provider adapters normalize this value to their supported effort levels. */
      effort: z.enum(["auto", "low", "medium", "high", "max", "xhigh"]).default("auto"),
    })
    .default({}),

  tokenBudget: z
    .object({
      warningThreshold: z.number().min(0).max(100).default(80),
      hardLimit: z.number().optional(),
    })
    .default({}),

  /** Deterministic loop limits prevent runaway retries and cost drift. */
  executionBudget: z
    .object({
      maxModelTurnsPerRun: z.number().int().min(1).max(200).default(80),
      maxToolCallsPerRun: z.number().int().min(1).max(2000).default(300),
      /** Legacy totals only apply after explicit opt-in; old settings migrate to stages. */
      enforceTaskLimits: z.boolean().default(false),
      maxModelTurnsPerTask: z.number().int().min(1).max(500).default(160),
      maxToolCallsPerTask: z.number().int().min(1).max(2000).default(300),
    })
    .default({}),

  /** Agent runtime selection. External engines are optional and never auto-installed. */
  agentEngine: z
    .object({
      /** Auto keeps the built-in engine unless a tested external engine is explicitly selected. */
      mode: z
        .enum(["auto", "native", "codex", "deepseek-harness"])
        .default("auto"),
      /** Fall back to the built-in engine only when the selected engine cannot start. */
      fallbackToNative: z.boolean().default(true),
      codexCommand: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .regex(/^[^\r\n\0]+$/, "Codex 命令不能包含换行或空字符")
        .default("codex"),
      deepseekHarnessCommand: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .regex(/^[^\r\n\0]+$/, "DeepSeek Harness 命令不能包含换行或空字符")
        .default("dsh"),
    })
    .default({}),

  defaultPermissions: z
    .object({
      bash: PermissionLevelSchema.default("ask"),
      file_write: PermissionLevelSchema.default("ask"),
      file_edit: PermissionLevelSchema.default("ask"),
      file_read: PermissionLevelSchema.default("auto"),
      glob: PermissionLevelSchema.default("auto"),
      grep: PermissionLevelSchema.default("auto"),
      web_fetch: PermissionLevelSchema.default("ask"),
      web_search: PermissionLevelSchema.default("ask"),
      session_search: PermissionLevelSchema.default("auto"),
      evidence_read: PermissionLevelSchema.default("auto"),
      desktop_control: PermissionLevelSchema.default("ask"),
      plan_update: PermissionLevelSchema.default("auto"),
      verification_status: PermissionLevelSchema.default("auto"),
      phase_checkpoint: PermissionLevelSchema.default("auto"),
      sources_to_excel: PermissionLevelSchema.default("ask"),
      document_ocr: PermissionLevelSchema.default("ask"),
      document_verify: PermissionLevelSchema.default("auto"),
      document_format: PermissionLevelSchema.default("ask"),
      vision_analyze: PermissionLevelSchema.default("ask"),
      git_commit: PermissionLevelSchema.default("ask"),
      spawn_research: PermissionLevelSchema.default("ask"),
      service_start: PermissionLevelSchema.default("ask"),
      service_status: PermissionLevelSchema.default("auto"),
      service_stop: PermissionLevelSchema.default("auto"),
      browser_verify: PermissionLevelSchema.default("ask"),
    })
    .default({}),

  customRules: z
    .array(
      z.object({
        tool: z.union([
          z.enum(["bash", "file_read", "file_write", "file_edit", "glob", "grep", "web_fetch", "web_search", "session_search", "evidence_read", "plan_update", "verification_status", "phase_checkpoint", "sources_to_excel", "document_ocr", "document_verify", "document_format", "vision_analyze", "git_commit", "spawn_research", "service_start", "service_status", "service_stop", "browser_verify"]),
          z.literal("*"),
        ]),
        level: PermissionLevelSchema,
      })
    )
    .default([]),

  ui: z
    .object({
      theme: z.enum(["dark", "light", "auto"]).default("auto"),
      showThinking: z.boolean().default(false),
      showTokenCount: z.boolean().default(true),
      showCost: z.boolean().default(true),
    })
    .default({}),

  context: z
    .object({
      maxHistoryMessages: z.number().int().min(2).default(50),
      compactionThreshold: z.number().min(50).max(95).default(80),
      claudeMdPaths: z.array(z.string()).default([]),
      /**
       * Ceiling on the transcript resent to the model each turn — the main
       * cost lever, since every turn rebills the whole working set. Lower
       * spends less; higher keeps more history in view.
       */
      maxContextTokens: z.number().int().min(8_000).max(400_000).default(60_000),
      /** Trailing messages always kept in full, however tight the budget. */
      keepRecentMessages: z.number().int().min(4).max(200).default(20),
    })
    .default({}),

  // ── API Keys (per provider) ────────────────────────────────────────────────
  /** Anthropic API key */
  apiKey: z.string().optional(),
  /** OpenAI API key */
  openaiApiKey: z.string().optional(),
  /** DeepSeek API key */
  deepseekApiKey: z.string().optional(),
  /** Alibaba Cloud DashScope / Qwen API key */
  qwenApiKey: z.string().optional(),
  /** Groq API key */
  groqApiKey: z.string().optional(),
  /** Google Gemini API key */
  geminiApiKey: z.string().optional(),
  /** OpenRouter API key */
  openrouterApiKey: z.string().optional(),
  /** Moonshot/Kimi API key */
  moonshotApiKey: z.string().optional(),

  // ── Custom OAI-compatible endpoint ────────────────────────────────────────
  /** Base URL for provider=custom or provider=ollama override */
  customProviderUrl: z.string().optional(),
  /** API key for provider=custom */
  customProviderKey: z.string().optional(),

  /** Optional per-provider endpoint overrides (regional gateways / proxies). */
  providerBaseUrls: z.record(z.string().url()).default({}),

  // ── Long-term memory (I007 + I012) ───────────────────────────────────────
  memory: z
    .object({
      /** Enable automatic memory extraction after each session */
      enabled: z.boolean().default(true),
      /** Max chars of conversation fed to extractor (cost control) */
      maxConversationChars: z.number().int().min(2000).max(40000).default(12000),
      /** I012: Enable semantic retrieval (vector search) instead of full injection */
      semanticRetrieval: z.boolean().default(true),
      /** I012: Ollama embedding model (nomic-embed-text recommended) */
      embeddingModel: z.string().default("nomic-embed-text"),
      /** I012: Max memory chunks to inject per query */
      topK: z.number().int().min(1).max(30).default(8),
      /** I012: Minimum cosine similarity threshold (0–1) */
      similarityThreshold: z.number().min(0).max(1).default(0.25),
    })
    .default({}),

  // ── Local model (I011) ────────────────────────────────────────────────────
  localModel: z
    .object({
      /** Auto-discover running local model services (Ollama, LM Studio, etc.) */
      autoDiscover: z.boolean().default(true),
      /** Force a specific local service URL (overrides auto-discovery) */
      serviceUrl: z.string().optional(),
      /** I013: Use local model for memory extraction instead of Haiku */
      useForMemory: z.boolean().default(false),
      /** Local model name to use for memory extraction */
      memoryModel: z.string().default("qwen2.5:7b"),
    })
    .default({}),

  // ── Sandbox (Innovation 5) ────────────────────────────────────────────────
  sandbox: z
    .object({
      /** Enable Docker sandbox isolation for bash commands */
      enabled: z.boolean().default(false),
      /** Isolation level: strict (cwd read-only, no net) | standard | permissive */
      level: z.enum(["strict", "standard", "permissive"]).default("standard"),
      /** Docker image to use as execution environment */
      image: z.string().default("node:20-slim"),
      /** Per-command timeout in milliseconds */
      timeoutMs: z.number().int().min(1000).max(300_000).default(30_000),
      /** Container memory limit in MB */
      maxMemoryMb: z.number().int().min(64).max(4096).default(512),
      /** Allow outbound network access from container */
      allowNetwork: z.boolean().default(true),
      /** Keep one isolated environment alive across commands in the same task */
      persistent: z.boolean().default(true),
      /** Maximum process count inside the task container */
      pidsLimit: z.number().int().min(32).max(2048).default(256),
      /** Never silently leave the sandbox unless the user explicitly opts in */
      fallbackToHost: z.boolean().default(false),
    })
    .default({}),

  // ── Web search (I022) ────────────────────────────────────────────────────
  search: z
    .object({
      /** Preferred provider when multiple keys are configured */
      defaultProvider: z
        .enum(["auto", "searxng", "tavily", "brave", "serper", "duckduckgo"])
        .default("auto"),
      /** Self-hosted SearXNG endpoint; recommended for domestic/private networks */
      searxngUrl: z.string().url().optional(),
      /** Tavily API key — https://tavily.com (best quality, AI-optimised) */
      tavilyApiKey: z.string().optional(),
      /** Brave Search API key — https://brave.com/search/api */
      braveApiKey: z.string().optional(),
      /** Serper API key — https://serper.dev (Google results, 2500 free/mo) */
      serperApiKey: z.string().optional(),
    })
    .default({}),

  // ── GitHub integration ────────────────────────────────────────────────────
  github: z
    .object({
      /** Personal Access Token — enables GitHub REST API (5000 req/hr vs 60 unauthenticated).
       *  Minimum scope: public_repo (read-only).
       *  Generate at: https://github.com/settings/tokens */
      token: z.string().optional(),
    })
    .default({}),

  // ── Hooks (I027) — PreToolUse / PostToolUse shell commands ───────────────
  hooks: z
    .object({
      /** Commands to run BEFORE a tool executes. ${toolName}, ${path}, ${command}, ${cwd} available. */
      preToolUse: z
        .array(
          z.object({
            tool: z.string().describe("Tool name to match, or '*' for all tools"),
            command: z.string().describe("Shell command to execute (supports ${var} templates)"),
            failBehavior: z.enum(["warn", "block"]).default("warn"),
          }),
        )
        .default([]),
      /** Commands to run AFTER a tool executes. Output is appended to tool result for AI to see. */
      postToolUse: z
        .array(
          z.object({
            tool: z.string(),
            command: z.string(),
            failBehavior: z.enum(["warn", "block"]).default("warn"),
          }),
        )
        .default([]),
    })
    .default({}),

  // ── MCP (Model Context Protocol) servers ──────────────────────────────────
  mcpServers: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/, "MCP 名称只能包含字母、数字、短横线或下划线"),
        enabled: z.boolean().default(true),
        transport: z.enum(["stdio", "http"]),
        command: z.string().trim().max(500).optional(),
        args: z.array(z.string().max(500)).max(100).optional(),
        env: z.record(z.string()).optional(),
        url: z.string().url().optional(),
      }).superRefine((server, ctx) => {
        if (server.transport === "stdio" && !server.command) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["command"], message: "stdio MCP 必须配置启动命令" });
        }
        if (server.transport === "http" && !server.url) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: "HTTP MCP 必须配置有效地址" });
        }
      })
    )
    .max(20)
    .default([]),

  // ── Desktop onboarding and updates ───────────────────────────────────────
  onboarding: z
    .object({
      completed: z.boolean().default(false),
      completedAt: z.string().datetime().optional(),
      region: z.enum(["cn", "global"]).default("cn"),
    })
    .default({}),

  updates: z
    .object({
      enabled: z.boolean().default(true),
      channel: z.enum(["stable", "alpha"]).default("alpha"),
      automaticDownload: z.boolean().default(false),
    })
    .default({}),
});

export type AllyCodeSettings = z.infer<typeof SettingsSchema>;
// Transitional internal alias used by the existing terminal renderer.
export type DevAISettings = AllyCodeSettings;
