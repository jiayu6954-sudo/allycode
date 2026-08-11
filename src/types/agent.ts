import type Anthropic from "@anthropic-ai/sdk";
import type { NormalizedMessage } from "../providers/interface.js";

// Canonical message shape for the conversation history (Anthropic format internally)
export type ConversationMessage = Anthropic.MessageParam;

// Re-export for convenience
export type { NormalizedMessage };

// Richer message shape for the UI layer
export interface UIMessage {
  id: string;
  role: "user" | "assistant" | "tool_result" | "system";
  content: UIContentBlock[];
  timestamp: Date;
  tokenCount?: number;
  isStreaming?: boolean;
}

export type UIContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; toolName: string; toolId: string; input: unknown; status: ToolCallStatus; result?: string }
  | { type: "tool_result"; toolId: string; content: string; isError: boolean }
  | { type: "error"; message: string };

export type ToolCallStatus = "pending" | "running" | "success" | "error" | "denied";

export type AgentPhase =
  | "waiting_model"
  | "streaming"
  | "tool_running"
  | "waiting_model_after_tool"
  | "completed";

// Events emitted by the agent loop to consumers (UI, stdout printer, tests)
export type AgentEvent =
  | { type: "status"; phase: AgentPhase; iteration: number; toolName?: string; toolId?: string; stopReason?: string }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_pending"; toolName: string; toolId: string; input: unknown }
  | { type: "tool_start"; toolName: string; toolId: string; input: unknown }
  | { type: "tool_result"; toolId: string; toolName: string; content: string; isError: boolean }
  | { type: "tool_denied"; toolId: string; toolName: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
  | { type: "done"; stopReason: string }
  | { type: "error"; error: Error }
  /** I026: Human-in-the-loop checkpoint — agent paused for user review */
  | { type: "checkpoint"; message: string }
  /** Streaming progress chunk emitted by long-running bash commands (native only) */
  | { type: "tool_progress"; toolId: string; chunk: string };

export interface AgentLoopOptions {
  model: string;          // string, not ModelId — providers accept any model string
  maxTokens: number;
  systemPrompt: string;
  conversationHistory: ConversationMessage[];
  onEvent: (event: AgentEvent) => void;
  /** Persist a durable checkpoint whenever the canonical provider history changes. */
  onHistoryChange?: (
    history: ConversationMessage[],
  ) => void | Promise<void>;
  signal?: AbortSignal;
  /** I024: cap iterations for sub-loops (research loop uses 15, main loop uses 200) */
  maxIterations?: number;
  /** Innovation 8: token budget guard */
  tokenBudget?: {
    /** Warn (amber) when cumulative tokens exceed this % of hardLimit */
    warningThreshold: number;
    /** Abort the loop when cumulative tokens reach this absolute count */
    hardLimit?: number;
    /** Tokens already consumed by prior submits in this session */
    priorTokens: number;
  };
}

export interface AgentLoopResult {
  finalMessage: NormalizedMessage;
  updatedHistory: ConversationMessage[];
  totalUsage: TokenUsage;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
}

/**
 * ModelId — well-known model identifiers for autocomplete and cost calculation.
 * Agent loop accepts any string so users can pass custom model IDs.
 */
export type ModelId =
  // Anthropic
  | "claude-sonnet-4-6"
  | "claude-opus-4-6"
  | "claude-haiku-4-5-20251001"
  | "claude-opus-4-5"
  | "claude-sonnet-4-5"
  // OpenAI
  | "gpt-4o"
  | "gpt-4o-mini"
  | "o1"
  | "o3-mini"
  // DeepSeek
  | "deepseek-chat"
  | "deepseek-reasoner"
  | "qwen3-coder-plus"
  | "qwen-plus"
  // Groq
  | "llama-3.3-70b-versatile"
  | "mixtral-8x7b-32768"
  // Gemini
  | "gemini-2.0-flash"
  | "gemini-1.5-pro"
  // Moonshot
  | "moonshot-v1-8k"
  | "moonshot-v1-32k"
  // OpenRouter prefix (user can pass any openrouter model string)
  | (string & Record<never, never>); // allow arbitrary strings while keeping autocomplete

export type AgentMode = "interactive" | "pipe" | "headless";

export interface StatusInfo {
  model: string;
  totalTokens: number;
  estimatedCostUsd: number;
  sessionId?: string;
  /** 0–100: % of hardLimit consumed; undefined when no hardLimit is set */
  budgetUsedPct?: number;
}
