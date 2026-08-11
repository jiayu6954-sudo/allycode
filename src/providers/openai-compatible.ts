/**
 * Generic OpenAI-compatible provider.
 *
 * Works with any API that follows the OpenAI chat completions protocol:
 *   - OpenAI       (https://api.openai.com/v1)
 *   - DeepSeek     (https://api.deepseek.com/v1)
 *   - Groq         (https://api.groq.com/openai/v1)
 *   - Google Gemini(https://generativelanguage.googleapis.com/v1beta/openai/)
 *   - Ollama       (http://localhost:11434/v1)
 *   - OpenRouter   (https://openrouter.ai/api/v1)
 *   - Moonshot/Kimi(https://api.moonshot.cn/v1)
 *   - Any custom OAI-compatible endpoint
 *
 * Uses native fetch — no openai npm package needed.
 */
import type {
  AIProvider,
  ProviderName,
  StreamParams,
  ProviderStreamHandle,
  NormalizedMessage,
  NormalizedDelta,
  NormalizedBlock,
} from "./interface.js";
import type { ConversationMessage } from "../types/agent.js";
import type { ToolDefinition } from "../types/tools.js";
import { logger } from "../utils/logger.js";

// ── Predefined provider endpoints ─────────────────────────────────────────────

export interface OAIProviderPreset {
  name: ProviderName;
  baseUrl: string;
  envKey: string;
  defaultModel: string;
  /** Hard cap on max_tokens for this provider (undefined = no cap) */
  maxTokensLimit?: number;
  maxTokensParameter?: "max_tokens" | "max_completion_tokens";
}

export const PROVIDER_PRESETS: Record<string, OAIProviderPreset> = {
  openai: {
    name: "openai",
    baseUrl: "https://api.openai.com/v1",
    envKey: "OPENAI_API_KEY",
    defaultModel: "gpt-4o",
    maxTokensParameter: "max_completion_tokens",
  },
  deepseek: {
    name: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    envKey: "DEEPSEEK_API_KEY",
    defaultModel: "deepseek-chat",
    maxTokensLimit: 8192,
  },
  qwen: {
    name: "qwen",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    envKey: "DASHSCOPE_API_KEY",
    defaultModel: "qwen3-coder-plus",
  },
  groq: {
    name: "groq",
    baseUrl: "https://api.groq.com/openai/v1",
    envKey: "GROQ_API_KEY",
    defaultModel: "llama-3.3-70b-versatile",
    maxTokensLimit: 8192,
  },
  gemini: {
    name: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    envKey: "GEMINI_API_KEY",
    defaultModel: "gemini-2.0-flash",
  },
  ollama: {
    name: "ollama",
    baseUrl: "http://localhost:11434/v1",
    envKey: "",
    defaultModel: "llama3.2",
    maxTokensLimit: 4096,
  },
  openrouter: {
    name: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    envKey: "OPENROUTER_API_KEY",
    defaultModel: "openai/gpt-4o",
  },
  moonshot: {
    name: "moonshot",
    baseUrl: "https://api.moonshot.cn/v1",
    envKey: "MOONSHOT_API_KEY",
    defaultModel: "moonshot-v1-8k",
    maxTokensLimit: 8192,
  },
};

// ── Wire types (OpenAI protocol, minimal) ─────────────────────────────────────

interface OAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OAIToolCall[];
  tool_call_id?: string;
}

interface OAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

interface OAIChunk {
  choices: Array<{
    delta: {
      content?: string;
      reasoning_content?: string; // DeepSeek-R1 thinking tokens
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: string | null;
  }>;
  usage?: OAIUsage;
}

// ── Conversion helpers ────────────────────────────────────────────────────────

/** ToolDefinition (Anthropic input_schema format) → OpenAI function tool */
function toOAITool(def: ToolDefinition): object {
  return {
    type: "function",
    function: {
      name: def.name,
      description: def.description,
      parameters: def.input_schema,
    },
  };
}

/**
 * Convert Anthropic-format conversation history + system prompt → OAI messages.
 */
function toOAIMessages(
  systemPrompt: string,
  messages: ConversationMessage[]
): OAIMessage[] {
  const result: OAIMessage[] = [{ role: "system", content: systemPrompt }];

  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        result.push({ role: "user", content: msg.content });
        continue;
      }

      const toolResults: OAIMessage[] = [];
      const textParts: string[] = [];

      for (const block of msg.content) {
        if (block.type === "tool_result") {
          const raw = block.content;
          const text =
            typeof raw === "string"
              ? raw
              : Array.isArray(raw)
              ? raw.map((c) => (c.type === "text" ? c.text : "")).join("")
              : "";
          toolResults.push({
            role: "tool",
            tool_call_id: block.tool_use_id,
            content: text,
          });
        } else if (block.type === "text") {
          textParts.push(block.text);
        }
      }

      result.push(...toolResults);
      if (textParts.length > 0) {
        result.push({ role: "user", content: textParts.join("\n") });
      }
    } else if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        result.push({ role: "assistant", content: msg.content });
        continue;
      }

      const textBlocks = msg.content.filter((b) => b.type === "text");
      const toolUseBlocks = msg.content.filter((b) => b.type === "tool_use");

      if (toolUseBlocks.length > 0) {
        result.push({
          role: "assistant",
          content: textBlocks.length > 0
            ? textBlocks.map((b) => (b.type === "text" ? b.text : "")).join("")
            : null,
          tool_calls: toolUseBlocks
            .filter((b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use")
            .map((b) => ({
              id: b.id,
              type: "function" as const,
              function: { name: b.name, arguments: JSON.stringify(b.input) },
            })),
        });
      } else {
        result.push({
          role: "assistant",
          content: textBlocks.map((b) => (b.type === "text" ? b.text : "")).join(""),
        });
      }
    }
  }

  return result;
}

// ── SSE parser ────────────────────────────────────────────────────────────────

// Timeout constants for stream health checks
const TTFT_TIMEOUT_MS   = 3 * 60 * 1_000;  // 3 min — time to first token
const CHUNK_TIMEOUT_MS  = 2 * 60 * 1_000;  // 2 min — max silence between chunks

/**
 * Wrap a reader.read() call with a hard deadline.
 * Rejects with a TimeoutError if no chunk arrives within `ms` milliseconds.
 */
function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ms: number,
  label: string
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(
        `Stream ${label} timeout after ${ms / 1000}s — ` +
        `provider sent no data. Try again or switch provider.`
      ));
    }, ms);
    reader.read().then(
      (result) => { clearTimeout(timer); resolve(result); },
      (err)    => { clearTimeout(timer); reject(err); }
    );
  });
}

async function* parseSSE(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<OAIChunk> {
  const decoder = new TextDecoder();
  let buffer = "";
  let firstChunk = true;

  try {
    while (true) {
      if (signal?.aborted) break;

      // Use a longer timeout for the very first chunk (TTFT can be high for
      // large contexts), shorter for subsequent chunks (inter-chunk silence).
      const timeoutMs = firstChunk ? TTFT_TIMEOUT_MS : CHUNK_TIMEOUT_MS;
      const label     = firstChunk ? "TTFT" : "inter-chunk";

      const { done, value } = await readWithTimeout(reader, timeoutMs, label);
      if (done) break;
      firstChunk = false;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") return;
        try {
          yield JSON.parse(data) as OAIChunk;
        } catch {
          // Malformed chunk — skip
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ── Provider class ────────────────────────────────────────────────────────────

export class OpenAICompatibleProvider implements AIProvider {
  readonly providerName: ProviderName;

  constructor(
    private baseUrl: string,
    private apiKey: string,
    providerName: ProviderName,
    private maxTokensLimit?: number
    , private maxTokensParameter: "max_tokens" | "max_completion_tokens" = "max_tokens"
  ) {
    this.providerName = providerName;
  }

  stream(params: StreamParams): ProviderStreamHandle {
    const clamped = this.maxTokensLimit
      ? Math.min(params.maxTokens, this.maxTokensLimit)
      : params.maxTokens;
    return new OAIStreamHandle(
      this.baseUrl,
      this.apiKey,
      { ...params, maxTokens: clamped },
      this.maxTokensParameter,
    );
  }
}

// ── Stream handle ─────────────────────────────────────────────────────────────

class OAIStreamHandle implements ProviderStreamHandle {
  private accText = "";
  private accThinking = "";
  private toolCallAcc: Map<number, { id: string; name: string; arguments: string }> = new Map();
  private finishReason: string | null = null;
  private finalUsage: OAIUsage | null = null;
  private streamConsumed = false;
  private streamPromise: Promise<void> | null = null;
  private streamError: Error | null = null;
  private deltaQueue: NormalizedDelta[] = [];
  private deltaResolvers: Array<() => void> = [];

  // <think> tag state machine for Ollama R1 compatibility
  // Ollama embeds thinking in content as <think>...</think> instead of reasoning_content
  private inThinkBlock = false;
  private thinkBuf = "";  // partial tag buffer for split-chunk detection

  constructor(
    private baseUrl: string,
    private apiKey: string,
    private params: StreamParams,
    private maxTokensParameter: "max_tokens" | "max_completion_tokens",
  ) {}

  async *deltas(): AsyncIterable<NormalizedDelta> {
    this.ensureStream();
    let index = 0;
    while (true) {
      if (index < this.deltaQueue.length) {
        yield this.deltaQueue[index++]!;
      } else if (this.streamConsumed) {
        break;
      } else {
        await new Promise<void>((resolve) => {
          this.deltaResolvers.push(resolve);
        });
      }
    }
    if (this.streamError) throw this.streamError;
  }

  /**
   * Route incoming content through a <think>...</think> state machine.
   * Ollama's R1 embeds thinking in content rather than reasoning_content.
   * Chunks may split mid-tag, so we buffer partial tags in thinkBuf.
   */
  private processContent(text: string): void {
    let remaining = this.thinkBuf + text;
    this.thinkBuf = "";

    while (remaining.length > 0) {
      if (this.inThinkBlock) {
        const closeIdx = remaining.indexOf("</think>");
        if (closeIdx === -1) {
          // No closing tag yet — all remaining is thinking
          this.accThinking += remaining;
          this.pushDelta({ type: "thinking", text: remaining });
          remaining = "";
        } else {
          // Emit up to close tag as thinking, then exit block
          const thinkPart = remaining.slice(0, closeIdx);
          if (thinkPart) {
            this.accThinking += thinkPart;
            this.pushDelta({ type: "thinking", text: thinkPart });
          }
          this.inThinkBlock = false;
          remaining = remaining.slice(closeIdx + "</think>".length);
        }
      } else {
        const openIdx = remaining.indexOf("<think>");
        if (openIdx === -1) {
          // Check if the tail could be a partial opening tag
          const partialMatch = partialTagSuffix(remaining, "<think>");
          if (partialMatch > 0) {
            // Emit confirmed text, buffer the possible partial tag
            const confirmed = remaining.slice(0, remaining.length - partialMatch);
            if (confirmed) {
              this.accText += confirmed;
              this.pushDelta({ type: "text", text: confirmed });
            }
            this.thinkBuf = remaining.slice(remaining.length - partialMatch);
            remaining = "";
          } else {
            // No think tag at all — emit as normal text
            this.accText += remaining;
            this.pushDelta({ type: "text", text: remaining });
            remaining = "";
          }
        } else {
          // Emit text before the tag, then enter thinking block
          const textPart = remaining.slice(0, openIdx);
          if (textPart) {
            this.accText += textPart;
            this.pushDelta({ type: "text", text: textPart });
          }
          this.inThinkBlock = true;
          remaining = remaining.slice(openIdx + "<think>".length);
        }
      }
    }
  }

  private pushDelta(delta: NormalizedDelta): void {
    this.deltaQueue.push(delta);
    this.deltaResolvers.shift()?.();
  }

  private ensureStream(): void {
    if (!this.streamPromise) {
      this.streamPromise = this.runStream().catch((err) => {
        logger.error("oai.stream.error", err);
        this.streamError = err instanceof Error ? err : new Error(String(err));
        this.streamConsumed = true;
        for (const r of this.deltaResolvers) r();
        this.deltaResolvers = [];
      });
    }
  }

  private async runStream(): Promise<void> {
    const messages = toOAIMessages(this.params.systemPrompt, this.params.messages);
    const tools = this.params.tools.map(toOAITool);

    const body: Record<string, unknown> = {
      model: this.params.model,
      stream: true,
      messages,
    };
    body[this.maxTokensParameter] = this.params.maxTokens;

    if (tools.length > 0) {
      body["tools"] = tools;
      body["tool_choice"] = "auto";
    }

    logger.debug("oai.stream.start", { model: this.params.model, baseUrl: this.baseUrl });

    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: this.params.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      // Parse JSON error body to extract human-readable message
      let detail = text;
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string } };
        if (parsed?.error?.message) detail = parsed.error.message;
      } catch { /* keep raw text */ }

      // Translate common HTTP codes into actionable messages
      let hint = "";
      if (response.status === 402) {
        hint = "\n→ API account has insufficient balance. Please top up your account.";
      } else if (response.status === 401) {
        hint = "\n→ Invalid API key. Check your key in Settings.";
      } else if (response.status === 429) {
        hint = "\n→ Rate limit reached. Wait a moment and try again.";
      } else if (response.status === 503 || response.status === 529) {
        hint = "\n→ Provider is temporarily overloaded. Try again shortly.";
      }

      throw new Error(`${this.params.model} API error ${response.status}: ${detail}${hint}`);
    }

    if (!response.body) throw new Error("Empty response body");

    const reader = response.body.getReader();

    try {
      for await (const chunk of parseSSE(reader, this.params.signal)) {
        const choice = chunk.choices[0];
        if (!choice) {
          if (chunk.usage) this.finalUsage = chunk.usage;
          continue;
        }

        const { delta, finish_reason } = choice;

        if (delta.content) {
          this.processContent(delta.content);
        }

        if (delta.reasoning_content) {
          this.accThinking += delta.reasoning_content;
          this.pushDelta({ type: "thinking", text: delta.reasoning_content });
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const acc = this.toolCallAcc.get(tc.index) ?? { id: "", name: "", arguments: "" };
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name += tc.function.name;
            if (tc.function?.arguments) acc.arguments += tc.function.arguments;
            this.toolCallAcc.set(tc.index, acc);
          }
        }

        if (finish_reason) this.finishReason = finish_reason;
        if (chunk.usage) this.finalUsage = chunk.usage;
      }
    } finally {
      this.streamConsumed = true;
      for (const r of this.deltaResolvers) r();
      this.deltaResolvers = [];
      logger.debug("oai.stream.done", { finishReason: this.finishReason });
    }
  }

  async finalMessage(): Promise<NormalizedMessage> {
    // Ensure stream has run (deltas() may not have been called)
    this.ensureStream();
    await this.streamPromise;
    if (this.streamError) throw this.streamError;

    const content: NormalizedBlock[] = [];

    if (this.accText) {
      content.push({ type: "text", text: this.accText });
    }

    for (const [, tc] of this.toolCallAcc) {
      let input: unknown;
      try {
        input = JSON.parse(tc.arguments || "{}");
      } catch {
        input = { raw: tc.arguments };
      }
      content.push({
        type: "tool_use",
        id: tc.id || `call_${Math.random().toString(36).slice(2)}`,
        name: tc.name,
        input,
      });
    }
    if (content.length === 0) {
      throw new Error(
        "Provider returned an empty response. Check the model name, endpoint, and API credentials.",
      );
    }

    // Normalize finish_reason → stop_reason
    let stopReason: NormalizedMessage["stop_reason"] = "end_turn";
    if (this.finishReason === "tool_calls") stopReason = "tool_use";
    else if (this.finishReason === "length") stopReason = "max_tokens";
    else if (this.finishReason === "stop") stopReason = "end_turn";

    const cached = this.finalUsage?.prompt_tokens_details?.cached_tokens ?? 0;

    return {
      stop_reason: stopReason,
      content,
      usage: {
        input_tokens: (this.finalUsage?.prompt_tokens ?? 0) - cached,
        output_tokens: this.finalUsage?.completion_tokens ?? 0,
        cache_read_input_tokens: cached > 0 ? cached : undefined,
      },
    };
  }
}

/**
 * Returns how many trailing characters of `s` could be the start of `tag`.
 * Used to buffer potential partial tags that span chunk boundaries.
 * e.g. s="hello <thi", tag="<think>" → returns 4 (buffering "<thi")
 */
function partialTagSuffix(s: string, tag: string): number {
  for (let len = Math.min(s.length, tag.length - 1); len > 0; len--) {
    if (s.endsWith(tag.slice(0, len))) return len;
  }
  return 0;
}
