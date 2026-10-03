import type {
  ProviderCapabilities,
  ProviderName,
  ProviderProtocol,
} from "./interface.js";

/** Where a model identifier came from. `live` only means the provider listed it. */
export type ModelCatalogSource = "live" | "fallback";

/**
 * Capability verification is deliberately separate from availability.
 * A provider-listed model is not automatically certified for tools/reasoning.
 */
export type ModelVerification = "official" | "provider-listed" | "unverified";

export interface ModelCatalogEntry {
  id: string;
  provider: ProviderName;
  /** Whether the model was returned by the live endpoint or only a local fallback. */
  source: ModelCatalogSource;
  verification: ModelVerification;
  /** Protocols confirmed by the registry, or the requested protocol when unknown. */
  protocols: ProviderProtocol[];
  capabilities: ProviderCapabilities;
}

export interface ModelCatalogResult {
  provider: ProviderName;
  /** Whether the remote model-list request itself succeeded. */
  retrieval: ModelCatalogSource;
  fetchedAt: string;
  models: ModelCatalogEntry[];
  /** Safe, user-displayable warning. Never contains credentials or response bodies. */
  warning?: string;
}

export type ModelListStyle = "openai" | "anthropic" | "ollama";

export interface DiscoverModelCatalogOptions {
  provider: ProviderName;
  baseUrl?: string;
  apiKey?: string;
  selectedModel?: string;
  fallbackModelIds?: string[];
  protocol?: ProviderProtocol;
  style?: ModelListStyle;
  signal?: AbortSignal;
  /** Test/integration injection point. */
  fetchImpl?: typeof fetch;
}

interface CapabilityRegistration {
  provider: ProviderName;
  model: string;
  protocols: ProviderProtocol[];
  capabilities: Omit<ProviderCapabilities, "protocol">;
}

const DEEPSEEK_V4_CAPABILITIES: Omit<ProviderCapabilities, "protocol"> = {
  streaming: true,
  toolCalls: "native",
  reasoning: "supported",
  // Do not infer image input merely from the V4 name or text-model listing.
  vision: "unsupported",
  contextWindow: 1_000_000,
  maxOutputTokens: 384_000,
  source: "official",
  notes: [
    "DeepSeek V4 官方规格：1M 上下文、最高 384K 输出。",
    "官方协议核验日期 2026-09-15；AllyCode 实现 Chat Completions 与独立 Responses 路由。",
    "携带 tools 时必须回传所保留各轮的 reasoning_content，包括无工具调用的回复。",
  ],
};

const KIMI_K3_CAPABILITIES: Omit<ProviderCapabilities, "protocol"> = {
  streaming: true,
  toolCalls: "native",
  reasoning: "supported",
  vision: "supported",
  contextWindow: 1_000_000,
  maxOutputTokens: 1_048_576,
  source: "official",
  notes: [
    "Kimi K3 官方规格：1M 上下文，始终开启保留式思考。",
    "推理强度支持 low/high/max；工具续接必须原样回传 reasoning_content。",
    "自动前缀缓存无需 cache ID；联网搜索官方标记为更新中，不作为稳定能力。",
  ],
};

/**
 * Static capability facts are intentionally narrow. Model names not registered
 * here remain unverified until a capability probe certifies them.
 */
export const MODEL_CAPABILITY_REGISTRY: readonly CapabilityRegistration[] = [
  { provider: "deepseek", model: "deepseek-flash", protocols: ["chat_completions", "responses"], capabilities: { ...DEEPSEEK_V4_CAPABILITIES, vision: "supported", notes: [...DEEPSEEK_V4_CAPABILITIES.notes, "deepseek-flash 当前为 V4.1-Flash；图像输入受官方规格限制。"] } },
  {
    provider: "deepseek",
    model: "deepseek-v4-pro",
    protocols: ["chat_completions", "responses"],
    capabilities: DEEPSEEK_V4_CAPABILITIES,
  },
  {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    protocols: ["chat_completions", "responses"],
    capabilities: { ...DEEPSEEK_V4_CAPABILITIES, vision: "supported" },
  },
  {
    provider: "moonshot",
    model: "kimi-k3",
    protocols: ["chat_completions"],
    capabilities: KIMI_K3_CAPABILITIES,
  },
] as const;

const BUILTIN_FALLBACK_MODELS: Partial<Record<ProviderName, readonly string[]>> = {
  anthropic: ["claude-sonnet-4-6"],
  openai: ["gpt-4o"],
  deepseek: ["deepseek-flash", "deepseek-v4-pro", "deepseek-v4-flash"],
  qwen: ["qwen3-coder-plus"],
  groq: ["llama-3.3-70b-versatile"],
  gemini: ["gemini-2.0-flash"],
  openrouter: ["anthropic/claude-sonnet-4"],
  moonshot: ["kimi-k3", "kimi-k2.7-code-highspeed", "kimi-k2.6"],
};

/** Parse OpenAI/Anthropic `data[]` and Ollama `models[]` payloads. */
export function parseModelList(payload: unknown): string[] {
  if (!isRecord(payload)) return [];

  const rows = Array.isArray(payload.data)
    ? payload.data
    : Array.isArray(payload.models)
      ? payload.models
      : [];

  return stableUniqueSort(rows.flatMap((row) => {
    if (typeof row === "string") return [row];
    if (!isRecord(row)) return [];
    const id = row.id ?? row.name ?? row.model;
    return typeof id === "string" ? [id] : [];
  }));
}

/** Resolve only facts explicitly present in AllyCode's capability registry. */
export function getRegisteredModelCapabilities(
  provider: ProviderName,
  model: string,
): ModelCatalogEntry | undefined {
  const registration = MODEL_CAPABILITY_REGISTRY.find(
    (item) => item.provider === provider && item.model === model,
  );
  if (!registration) return undefined;

  return {
    id: model,
    provider,
    source: "fallback",
    verification: "official",
    protocols: [...registration.protocols],
    capabilities: {
      ...registration.capabilities,
      notes: [...registration.capabilities.notes],
      protocol: registration.protocols[0]!,
    },
  };
}

/**
 * Fetch and normalize the provider model list. Failure is non-fatal: callers
 * receive explicit fallback entries plus a credential-safe warning.
 */
export async function discoverModelCatalog(
  options: DiscoverModelCatalogOptions,
): Promise<ModelCatalogResult> {
  const style = options.style ?? defaultStyle(options.provider);
  const protocol = options.protocol ?? defaultProtocol(options.provider);
  const fallbackIds = stableUniqueSort([
    ...(BUILTIN_FALLBACK_MODELS[options.provider] ?? []),
    ...(options.fallbackModelIds ?? []),
    ...(options.selectedModel ? [options.selectedModel] : []),
  ]);

  let liveIds: string[] = [];
  let warning: string | undefined;
  let retrieval: ModelCatalogSource = "fallback";

  try {
    const url = modelListUrl(options.provider, options.baseUrl, style);
    const response = await (options.fetchImpl ?? fetch)(url, {
      headers: requestHeaders(style, options.apiKey),
      signal: options.signal,
    });

    if (!response.ok) {
      warning = `模型列表接口返回 HTTP ${response.status}，已使用本地候选列表。`;
    } else {
      liveIds = parseModelList(await response.json());
      retrieval = "live";
      if (liveIds.length === 0) {
        warning = "模型列表接口可访问，但未返回可识别的模型标识。";
      }
    }
  } catch (error) {
    warning = safeDiscoveryWarning(error, options.apiKey);
  }

  const liveSet = new Set(liveIds);
  const ids = stableUniqueSort([...liveIds, ...fallbackIds]);
  const models = ids.map((id) => makeCatalogEntry(
    options.provider,
    id,
    liveSet.has(id) ? "live" : "fallback",
    protocol,
  ));

  return {
    provider: options.provider,
    retrieval,
    fetchedAt: new Date().toISOString(),
    models,
    ...(warning ? { warning } : {}),
  };
}

function makeCatalogEntry(
  provider: ProviderName,
  id: string,
  source: ModelCatalogSource,
  protocol: ProviderProtocol,
): ModelCatalogEntry {
  const registered = getRegisteredModelCapabilities(provider, id);
  if (registered) return { ...registered, source };

  return {
    id,
    provider,
    source,
    verification: source === "live" ? "provider-listed" : "unverified",
    protocols: [protocol],
    capabilities: {
      protocol,
      streaming: true,
      toolCalls: "unverified",
      reasoning: "unverified",
      vision: "unverified",
      source: source === "live" ? "provider" : "fallback",
      notes: [
        source === "live"
          ? "模型由供应商列表接口返回；工具、思考与上下文能力尚未探测。"
          : "模型来自本地候选配置，当前账户可用性及能力均未验证。",
      ],
    },
  };
}

function defaultStyle(provider: ProviderName): ModelListStyle {
  if (provider === "anthropic") return "anthropic";
  if (provider === "ollama") return "ollama";
  return "openai";
}

function defaultProtocol(provider: ProviderName): ProviderProtocol {
  return provider === "anthropic" ? "anthropic" : "chat_completions";
}

function modelListUrl(
  provider: ProviderName,
  suppliedBaseUrl: string | undefined,
  style: ModelListStyle,
): string {
  if (style === "ollama") {
    const base = (suppliedBaseUrl ?? "http://127.0.0.1:11434")
      .replace(/\/$/, "")
      .replace(/\/v1$/, "");
    return `${base}/api/tags`;
  }

  const defaults: Partial<Record<ProviderName, string>> = {
    anthropic: "https://api.anthropic.com",
    openai: "https://api.openai.com/v1",
    deepseek: "https://api.deepseek.com/v1",
    qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    groq: "https://api.groq.com/openai/v1",
    gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
    openrouter: "https://openrouter.ai/api/v1",
    moonshot: "https://api.moonshot.cn/v1",
  };
  const base = (suppliedBaseUrl ?? defaults[provider]);
  if (!base) throw new Error("未配置模型列表接口地址");
  const normalized = base.replace(/\/$/, "");
  if (style === "anthropic") {
    return /\/v1$/i.test(normalized)
      ? `${normalized}/models`
      : `${normalized}/v1/models`;
  }
  return `${normalized}/models`;
}

function requestHeaders(style: ModelListStyle, apiKey?: string): HeadersInit {
  if (style === "anthropic") {
    return {
      ...(apiKey ? { "x-api-key": apiKey } : {}),
      "anthropic-version": "2023-06-01",
    };
  }
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function safeDiscoveryWarning(error: unknown, apiKey?: string): string {
  let detail = error instanceof Error ? error.message : String(error);
  if (apiKey) detail = detail.split(apiKey).join("[已隐藏密钥]");
  detail = detail
    .replace(/(?:Bearer\s+)?(?:sk|ds|ak)-[A-Za-z0-9._-]+/gi, "[已隐藏密钥]")
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, "https://[已隐藏凭据]@")
    .slice(0, 240);
  return `无法读取在线模型列表，已使用本地候选列表：${detail || "未知网络错误"}`;
}

function stableUniqueSort(values: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const raw of values) {
    const value = raw.trim();
    if (value) unique.add(value);
  }
  return [...unique].sort((left, right) => {
    const insensitive = left.localeCompare(right, "en", {
      numeric: true,
      sensitivity: "base",
    });
    return insensitive || left.localeCompare(right, "en", { numeric: true });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
