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

export interface NormalizedMessage {
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
  content: NormalizedBlock[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
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
  model: string;
  maxTokens: number;
  systemPrompt: string;
  messages: ConversationMessage[];
  tools: ToolDefinition[];
  signal?: AbortSignal;
}

export interface AIProvider {
  readonly providerName: ProviderName;
  stream(params: StreamParams): ProviderStreamHandle;
}
