/**
 * Provider abstraction layer.
 * Normalizes Anthropic and OpenAI-compatible APIs to a common interface.
 */
import type { ConversationMessage } from "../types/agent.js";
import type { ToolDefinition } from "../types/tools.js";

// ── Normalized delta events (streamed) ──────────────────────────────────────

export type NormalizedDelta =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string };

// ── Normalized final message ─────────────────────────────────────────────────

export type NormalizedBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

/**
 * Opaque protocol state that must survive a tool round.
 *
 * This is deliberately provider-neutral at the agent boundary. Providers may
 * use it to preserve reasoning/tool state without leaking protocol-specific
 * fields into another provider's request.
 */
export type ProviderTurnState =
  | {
      protocol: "deepseek-chat";
      scope?: ProviderStateScope;
      reasoningContent?: string;
    }
  | {
      protocol: "responses";
      scope?: ProviderStateScope;
      responseId?: string;
      outputItems: unknown[];
    };

export interface ProviderStateScope {
  provider: ProviderName;
  protocol: ProviderProtocol;
  model: string;
  baseUrl: string;
}

export interface NormalizedMessage {
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
  content: NormalizedBlock[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    reported?: boolean;
  };
  providerState?: ProviderTurnState;
}

// ── Stream handle returned by provider.stream() ──────────────────────────────

export interface ProviderStreamHandle {
  /** Async-iterable of streaming deltas (text / thinking) */
  deltas(): AsyncIterable<NormalizedDelta>;
  /** Resolves after streaming completes; returns the full normalized message */
  finalMessage(): Promise<NormalizedMessage>;
}

// ── Provider interface ────────────────────────────────────────────────────────

export type ProviderName =
  | "anthropic"
  | "openai"
  | "deepseek"
  | "qwen"
  | "groq"
  | "gemini"
  | "ollama"
  | "openrouter"
  | "moonshot"
  | "custom";

export interface StreamParams {
  purpose?: "main" | "compaction" | "research" | "memory" | "diagnostics";
  model: string;
  maxTokens: number;
  systemPrompt: string;
  messages: ConversationMessage[];
  tools: ToolDefinition[];
  signal?: AbortSignal;
}

export type ProviderProtocol = "anthropic" | "chat_completions" | "responses";

export interface ProviderCapabilities {
  protocol: ProviderProtocol;
  streaming: boolean;
  toolCalls: "native" | "prompt_fallback" | "unsupported" | "unverified";
  reasoning: "supported" | "unsupported" | "unverified";
  vision: "supported" | "unsupported" | "unverified";
  contextWindow?: number;
  maxOutputTokens?: number;
  source: "official" | "provider" | "probe" | "fallback";
  notes: string[];
}

export interface AIProvider {
  readonly providerName: ProviderName;
  readonly protocol?: ProviderProtocol;
  stream(params: StreamParams): ProviderStreamHandle;
}
