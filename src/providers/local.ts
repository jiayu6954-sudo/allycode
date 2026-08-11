/**
 * I011: Smart Local Model Provider
 *
 * 解决原 ollama provider 的三个痛点：
 * 1. 硬编码端口，无自动发现
 * 2. 不检测模型是否原生支持 function_calling
 * 3. 不支持 tool_call 的模型直接报错，无降级
 *
 * 创新点：
 * - 自动扫描常见本地模型服务端口（Ollama / LM Studio / llama.cpp / vLLM）
 * - 能力探针：发送带 tool 的 dry-run 请求判断是否支持
 * - XML 工具调用降级：将工具定义注入 system prompt，解析 <tool_call> 响应
 * - 动态上下文窗口：从 /api/show 读取模型实际 context length
 */

import { OpenAICompatibleProvider } from "./openai-compatible.js";
import type {
  AIProvider,
  ProviderName,
  StreamParams,
  ProviderStreamHandle,
  NormalizedMessage,
  NormalizedDelta,
  NormalizedBlock,
} from "./interface.js";
import { logger } from "../utils/logger.js";

// ── Known local service endpoints ────────────────────────────────────────────

export interface LocalEndpoint {
  name: string;
  baseUrl: string;
  /** Path to list available models */
  modelsPath: string;
  /** Path to get model info (optional) */
  infoPath?: string;
  /** Default model if none configured */
  defaultModel: string;
}

export const LOCAL_ENDPOINTS: LocalEndpoint[] = [
  {
    name: "ollama",
    baseUrl: "http://localhost:11434/v1",
    modelsPath: "http://localhost:11434/api/tags",
    infoPath: "http://localhost:11434/api/show",
    defaultModel: "qwen2.5-coder:7b",
  },
  {
    name: "lmstudio",
    baseUrl: "http://localhost:1234/v1",
    modelsPath: "http://localhost:1234/v1/models",
    defaultModel: "local-model",
  },
  {
    name: "llamacpp",
    baseUrl: "http://localhost:8080/v1",
    modelsPath: "http://localhost:8080/v1/models",
    defaultModel: "local-model",
  },
  {
    name: "vllm",
    baseUrl: "http://localhost:8000/v1",
    modelsPath: "http://localhost:8000/v1/models",
    defaultModel: "local-model",
  },
];

// Models known to support function_calling natively
const TOOL_CAPABLE_PATTERNS = [
  /qwen2\.5/i,
  /qwen3/i,
  /llama-3\.[123]/i,
  /llama3\.[123]/i,
  /mistral/i,
  /mixtral/i,
  /firefunction/i,
  /hermes/i,
  /functionary/i,
  /deepseek-v[23]/i,
  /command-r/i,
  /granite/i,
];

// ── Capability probe ──────────────────────────────────────────────────────────

export interface LocalCapabilities {
  endpoint: LocalEndpoint;
  availableModels: string[];
  supportsToolCalls: boolean;
  contextLength: number;
}

/**
 * Probe a local endpoint: check if it's reachable, list models, test tool support.
 * Returns null if endpoint is not reachable.
 */
export async function probeEndpoint(
  endpoint: LocalEndpoint,
  targetModel?: string
): Promise<LocalCapabilities | null> {
  try {
    // 1. Check if endpoint is reachable + list models
    const modelsRes = await fetch(endpoint.modelsPath, {
      signal: AbortSignal.timeout(3000),
    });
    if (!modelsRes.ok) return null;

    const modelsJson = await modelsRes.json() as unknown;
    const availableModels = extractModelNames(modelsJson);

    const model = targetModel ?? endpoint.defaultModel;

    // 2. Try to detect context length from model info (Ollama-specific)
    let contextLength = 4096;
    if (endpoint.infoPath) {
      try {
        const infoRes = await fetch(endpoint.infoPath, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: model }),
          signal: AbortSignal.timeout(3000),
        });
        if (infoRes.ok) {
          const info = await infoRes.json() as Record<string, unknown>;
          const params = info["parameters"] as string | undefined;
          const ctxMatch = params?.match(/num_ctx\s+(\d+)/);
          if (ctxMatch) contextLength = parseInt(ctxMatch[1]!, 10);
          // Also check modelinfo
          const modelInfo = info["model_info"] as Record<string, unknown> | undefined;
          if (modelInfo) {
            const ctxFromInfo = (
              modelInfo["llama.context_length"] ??
              modelInfo["context_length"]
            ) as number | undefined;
            if (ctxFromInfo) contextLength = ctxFromInfo;
          }
        }
      } catch {
        // Non-fatal
      }
    }

    // 3. Determine tool support: pattern match first, then probe
    const supportsToolCalls = modelSupportsTools(model)
      || await probeToolSupport(endpoint.baseUrl, model);

    logger.debug("local.probe", {
      name: endpoint.name,
      model,
      contextLength,
      supportsToolCalls,
      modelCount: availableModels.length,
    });

    return { endpoint, availableModels, supportsToolCalls, contextLength };
  } catch {
    return null;
  }
}

function extractModelNames(json: unknown): string[] {
  if (!json || typeof json !== "object") return [];
  const obj = json as Record<string, unknown>;
  // Ollama: { models: [{ name: "..." }] }
  if (Array.isArray(obj["models"])) {
    return (obj["models"] as Array<Record<string, unknown>>)
      .map((m) => String(m["name"] ?? m["id"] ?? ""))
      .filter(Boolean);
  }
  // OAI-compatible: { data: [{ id: "..." }] }
  if (Array.isArray(obj["data"])) {
    return (obj["data"] as Array<Record<string, unknown>>)
      .map((m) => String(m["id"] ?? ""))
      .filter(Boolean);
  }
  return [];
}

function modelSupportsTools(model: string): boolean {
  return TOOL_CAPABLE_PATTERNS.some((p) => p.test(model));
}

async function probeToolSupport(baseUrl: string, model: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
        tools: [{
          type: "function",
          function: { name: "test", description: "test", parameters: { type: "object", properties: {}, required: [] } },
        }],
        tool_choice: "none",
        stream: false,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) return true;
    if (res.status === 400) {
      // Distinguish "model doesn't support tools" (false) from other 400s
      const body = await res.text().catch(() => "");
      if (/does not support tools|tool.*not supported|not.*support.*tool/i.test(body)) return false;
      // Other 400 = request was parsed, tools field accepted
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ── Auto-discovery ────────────────────────────────────────────────────────────

/**
 * Scan all known local endpoints and return the first reachable one.
 * If targetUrl is provided, only probe that URL.
 */
export async function discoverLocalModel(
  targetUrl?: string,
  targetModel?: string
): Promise<LocalCapabilities | null> {
  if (targetUrl) {
    // User specified a custom URL — wrap it as a synthetic endpoint
    const synthetic: LocalEndpoint = {
      name: "custom-local",
      baseUrl: targetUrl,
      modelsPath: `${targetUrl.replace(/\/$/, "")}/models`,
      defaultModel: targetModel ?? "local-model",
    };
    return probeEndpoint(synthetic, targetModel);
  }

  // Probe all known endpoints in parallel
  const results = await Promise.all(
    LOCAL_ENDPOINTS.map((ep) => probeEndpoint(ep, targetModel))
  );

  return results.find((r) => r !== null) ?? null;
}

// ── XML tool call fallback ────────────────────────────────────────────────────

/**
 * When a model doesn't support native function_calling,
 * we inject tool definitions into the system prompt as XML schema
 * and parse <tool_call> tags from the response.
 *
 * Example injected section:
 *
 *   ## Available tools
 *   Call tools using this exact XML format:
 *   <tool_call>
 *   <name>tool_name</name>
 *   <input>{"param": "value"}</input>
 *   </tool_call>
 *
 *   ### file_read
 *   Read a file. Parameters: path (string, required), startLine (number), endLine (number)
 */
export function buildXmlToolPrompt(tools: import("../types/tools.js").ToolDefinition[]): string {
  if (tools.length === 0) return "";

  const toolDocs = tools.map((t) => {
    const props = t.input_schema.properties as Record<string, { type?: string; description?: string }>;
    const required = new Set(t.input_schema.required ?? []);
    const params = Object.entries(props)
      .map(([name, schema]) => {
        const req = required.has(name) ? " (required)" : " (optional)";
        return `    - ${name}: ${schema.type ?? "any"}${req} — ${schema.description ?? ""}`;
      })
      .join("\n");
    return `### ${t.name}\n${t.description}\nParameters:\n${params}`;
  }).join("\n\n");

  return `## CRITICAL INSTRUCTION: You MUST use tools to answer questions. Never guess, never describe what you would do — DO IT.

## How to call a tool (you must output EXACTLY this format, nothing before or after on the same line):
<tool_call>
<name>TOOL_NAME</name>
<input>{"param": "value"}</input>
</tool_call>

## Example — User asks: "what files are in the project?"
Your response MUST start with:
<tool_call>
<name>glob</name>
<input>{"pattern": "**/*", "limit": 30}</input>
</tool_call>
NOT with sentences describing what you plan to do.

## Example — User asks: "read config.yaml"
Your response MUST start with:
<tool_call>
<name>file_read</name>
<input>{"path": "config.yaml"}</input>
</tool_call>

## Rules
- ALWAYS call a tool first before writing any analysis or explanation.
- DO NOT write steps, plans, or methodology — call tools immediately.
- After a tool result arrives, you may call another tool or write your analysis.
- If you need to read multiple files, call tools one at a time and wait for results.

## Available Tools

${toolDocs}`;
}

/**
 * Parse <tool_call> blocks from an LLM text response.
 * Returns extracted tool calls and the remaining text (non-tool content).
 */
export function parseXmlToolCalls(
  text: string
): { toolCalls: Array<{ name: string; input: unknown }>; remainingText: string } {
  const toolCalls: Array<{ name: string; input: unknown }> = [];
  const xmlPattern = /<tool_call>\s*<name>([\s\S]*?)<\/name>\s*<input>([\s\S]*?)<\/input>\s*<\/tool_call>/g;

  let remainingText = text;
  let match: RegExpExecArray | null;

  while ((match = xmlPattern.exec(text)) !== null) {
    const name = match[1]!.trim();
    const inputRaw = match[2]!.trim();
    let input: unknown;
    try {
      input = JSON.parse(inputRaw);
    } catch {
      input = { raw: inputRaw };
    }
    toolCalls.push({ name, input });
    // Remove matched block from remaining text
    remainingText = remainingText.replace(match[0], "").trim();
  }

  return { toolCalls, remainingText };
}

// ── SmartLocalProvider ────────────────────────────────────────────────────────

export class SmartLocalProvider implements AIProvider {
  readonly providerName: ProviderName = "ollama";

  private inner: OpenAICompatibleProvider;
  private caps: LocalCapabilities;

  constructor(caps: LocalCapabilities, model: string) {
    this.caps = caps;
    this.inner = new OpenAICompatibleProvider(
      caps.endpoint.baseUrl,
      "",
      "ollama",
      caps.contextLength,
    );
    this._model = model;
  }

  private _model: string;

  stream(params: StreamParams): ProviderStreamHandle {
    if (this.caps.supportsToolCalls) {
      // Native tool calling — delegate to OpenAICompatibleProvider
      return this.inner.stream({ ...params, model: this._model });
    }

    // XML fallback — inject tool schema into system prompt, parse response
    return new XmlFallbackStreamHandle(
      this.caps.endpoint.baseUrl,
      this._model,
      params,
    );
  }

  get model(): string { return this._model; }
  get contextLength(): number { return this.caps.contextLength; }
  get endpointName(): string { return this.caps.endpoint.name; }
  get hasNativeTools(): boolean { return this.caps.supportsToolCalls; }
  get availableModels(): string[] { return this.caps.availableModels; }
}

// ── XML fallback stream handle ────────────────────────────────────────────────

/**
 * Streaming XML fallback for models that don't support native function_calling.
 *
 * Uses server-sent events (stream: true) so tokens appear in the UI in real-time.
 * The <think>...</think> state machine routes DeepSeek-R1 thinking tokens
 * to the "thinking" delta type (shown dimmed / hidden per showThinking setting).
 * Tool calls are accumulated in the full text and parsed after streaming ends.
 */
class XmlFallbackStreamHandle implements ProviderStreamHandle {
  private accText = "";          // final answer text only (no think blocks)
  private accThinking = "";      // thinking content
  private accFull = "";          // full raw text (for tool call parsing)
  private streamDone = false;
  private streamPromise: Promise<void> | null = null;
  private deltaQueue: NormalizedDelta[] = [];
  private deltaResolvers: Array<() => void> = [];
  private inThinkBlock = false;
  private thinkBuf = "";

  constructor(
    private baseUrl: string,
    private model: string,
    private params: StreamParams,
  ) {}

  async *deltas(): AsyncIterable<NormalizedDelta> {
    this.ensureStream();
    let index = 0;
    while (true) {
      if (index < this.deltaQueue.length) {
        yield this.deltaQueue[index++]!;
      } else if (this.streamDone) {
        break;
      } else {
        await new Promise<void>((r) => this.deltaResolvers.push(r));
      }
    }
  }

  async finalMessage(): Promise<NormalizedMessage> {
    this.ensureStream();
    await this.streamPromise;

    const { toolCalls, remainingText } = parseXmlToolCalls(this.accFull);
    const visibleText = remainingText
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .replace(/^[\s\S]*?<\/think>/i, "")
      .trim();
    const content: NormalizedBlock[] = [];
    if (visibleText) content.push({ type: "text", text: visibleText });
    for (const tc of toolCalls) {
      content.push({
        type: "tool_use",
        id: `xml_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        name: tc.name,
        input: tc.input,
      });
    }
    return {
      stop_reason: toolCalls.length > 0 ? "tool_use" : "end_turn",
      content,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }

  private pushDelta(d: NormalizedDelta): void {
    this.deltaQueue.push(d);
    this.deltaResolvers.shift()?.();
  }

  private ensureStream(): void {
    if (!this.streamPromise) {
      this.streamPromise = this.runStream().finally(() => {
        this.streamDone = true;
        for (const r of this.deltaResolvers) r();
        this.deltaResolvers = [];
      });
    }
  }

  private async runStream(): Promise<void> {
    const xmlToolPrompt = buildXmlToolPrompt(this.params.tools);
    const systemPrompt = xmlToolPrompt
      ? `${this.params.systemPrompt}\n\n${xmlToolPrompt}`
      : this.params.systemPrompt;

    const messages = buildOAIMessages(systemPrompt, this.params.messages);

    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        max_tokens: this.params.maxTokens,
        stream: true,
        messages,
      }),
      signal: this.params.signal,
    });

    if (!res.ok) {
      const err = await res.text().catch(() => "");
      throw new Error(`Local model ${res.status}: ${err}`);
    }
    if (!res.body) throw new Error("Empty response body from local model");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          const data = trimmed.slice(6);
          if (data === "[DONE]") return;
          try {
            const chunk = JSON.parse(data) as {
              choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }>
            };
            const delta = chunk.choices?.[0]?.delta;
            if (!delta) continue;

            // reasoning_content field (DeepSeek API format)
            if (delta.reasoning_content) {
              this.accThinking += delta.reasoning_content;
              this.pushDelta({ type: "thinking", text: delta.reasoning_content });
            }

            // content field — run through <think> state machine
            if (delta.content) {
              this.accFull += delta.content;
              this.processChunk(delta.content);
            }
          } catch { /* malformed chunk */ }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /** Route content through <think>...</think> state machine.
   *
   * Handles two R1 formats:
   *  - Standard:  <think>...thinking...</think>\nAnswer
   *  - Ollama:    ...thinking...</think>\nAnswer  (opening tag stripped by template)
   *
   * In the Ollama format the content before </think> is emitted as "thinking" deltas;
   * content after </think> is emitted as "text" deltas.
   */
  private processChunk(text: string): void {
    let remaining = this.thinkBuf + text;
    this.thinkBuf = "";

    while (remaining.length > 0) {
      if (this.inThinkBlock) {
        // --- Inside an explicit <think> block ---
        const closeIdx = remaining.indexOf("</think>");
        if (closeIdx === -1) {
          // Check for partial closing tag at end of chunk
          const partial = partialSuffix(remaining, "</think>");
          if (partial > 0) {
            const confirmed = remaining.slice(0, remaining.length - partial);
            if (confirmed) {
              this.accThinking += confirmed;
              this.pushDelta({ type: "thinking", text: confirmed });
            }
            this.thinkBuf = remaining.slice(remaining.length - partial);
            remaining = "";
          } else {
            this.accThinking += remaining;
            this.pushDelta({ type: "thinking", text: remaining });
            remaining = "";
          }
        } else {
          const thinkPart = remaining.slice(0, closeIdx);
          if (thinkPart) {
            this.accThinking += thinkPart;
            this.pushDelta({ type: "thinking", text: thinkPart });
          }
          this.inThinkBlock = false;
          remaining = remaining.slice(closeIdx + "</think>".length);
        }
      } else {
        // --- Outside a think block ---
        const openIdx = remaining.indexOf("<think>");
        const closeIdx = remaining.indexOf("</think>");

        // Ollama R1: </think> appears without a preceding <think>
        // Everything before </think> is thinking content, everything after is the answer.
        if (closeIdx !== -1 && (openIdx === -1 || closeIdx < openIdx)) {
          const thinkPart = remaining.slice(0, closeIdx);
          if (thinkPart) {
            this.accThinking += thinkPart;
            this.pushDelta({ type: "thinking", text: thinkPart });
          }
          remaining = remaining.slice(closeIdx + "</think>".length);
          // Trim leading whitespace that R1 inserts between </think> and the answer
          remaining = remaining.replace(/^\s+/, "");
          // Stay outside think block — the answer follows
          continue;
        }

        if (openIdx === -1) {
          // Check for partial <think> tag at end of chunk
          const partial = partialSuffix(remaining, "<think>");
          if (partial > 0) {
            const confirmed = remaining.slice(0, remaining.length - partial);
            if (confirmed) {
              this.accText += confirmed;
              this.pushDelta({ type: "text", text: confirmed });
            }
            this.thinkBuf = remaining.slice(remaining.length - partial);
            remaining = "";
          } else {
            this.accText += remaining;
            this.pushDelta({ type: "text", text: remaining });
            remaining = "";
          }
        } else {
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
}

function partialSuffix(s: string, tag: string): number {
  for (let len = Math.min(s.length, tag.length - 1); len > 0; len--) {
    if (s.endsWith(tag.slice(0, len))) return len;
  }
  return 0;
}

// Minimal OAI message builder for XML fallback (no tool result conversion needed)
function buildOAIMessages(
  systemPrompt: string,
  messages: import("../types/agent.js").ConversationMessage[]
): Array<{ role: string; content: string }> {
  const result: Array<{ role: string; content: string }> = [
    { role: "system", content: systemPrompt },
  ];
  for (const msg of messages) {
    const content =
      typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
        ? msg.content
            .map((b) => {
              if (typeof b === "string") return b;
              if ("text" in b) return (b as { text: string }).text;
              if ("type" in b && (b as { type: string }).type === "tool_result") {
                const c = (b as { content?: string | Array<{ text: string }> }).content;
                return typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => x.text).join("") : "";
              }
              return "";
            })
            .filter(Boolean)
            .join("\n")
        : "";
    if (content.trim()) {
      result.push({ role: msg.role, content });
    }
  }
  return result;
}
