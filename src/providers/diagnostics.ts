import type { AllyCodeSettings } from "../config/schema.js";
import { createProvider, PROVIDER_PRESETS } from "./index.js";
import type { NormalizedMessage, ProviderName, ProviderProtocol } from "./interface.js";
import type { ConversationMessage } from "../types/agent.js";
import { normalizeProviderModelId } from "./model-id.js";

export type ProviderTestStage =
  | "configuration"
  | "model_discovery"
  | "chat"
  | "tool_call"
  | "tool_result_roundtrip";

export interface ProviderStageResult {
  stage: ProviderTestStage;
  ok: boolean;
  message: string;
  latencyMs?: number;
}

export interface ProviderTestResult {
  provider: ProviderName;
  model: string;
  ok: boolean;
  testedAt: string;
  stages: ProviderStageResult[];
  fieldErrors: Partial<Record<"credential" | "model" | "baseUrl" | "network", string>>;
  capability: {
    level: "unavailable" | "chat_only" | "tool_call_only" | "agent_ready";
    protocol: ProviderProtocol | "unknown";
    nativeToolRoundtrip: boolean;
    source: "live_probe";
  };
}

const PROBE_TIMEOUT_MS = 45_000;

export async function testProviderCompatibility(
  settings: AllyCodeSettings,
): Promise<ProviderTestResult> {
  const provider = settings.provider as ProviderName;
  const stages: ProviderStageResult[] = [];
  const fieldErrors: ProviderTestResult["fieldErrors"] = {};
  let client: ReturnType<typeof createProvider> | undefined;
  const result = (): ProviderTestResult => ({
    provider,
    model: settings.model,
    ok: stages.length === 5 && stages.every((stage) => stage.ok),
    testedAt: new Date().toISOString(),
    stages,
    fieldErrors,
    capability: {
      level: stages.some((stage) => stage.stage === "tool_result_roundtrip" && stage.ok)
        ? "agent_ready"
        : stages.some((stage) => stage.stage === "tool_call" && stage.ok)
          ? "tool_call_only"
          : stages.some((stage) => stage.stage === "chat" && stage.ok)
            ? "chat_only"
            : "unavailable",
      protocol: client?.protocol ?? "unknown",
      nativeToolRoundtrip: stages.some((stage) =>
        stage.stage === "tool_result_roundtrip" && stage.ok
      ),
      source: "live_probe",
    },
  });

  if (!settings.model.trim()) {
    fieldErrors.model = "模型名称不能为空。";
    stages.push({ stage: "configuration", ok: false, message: fieldErrors.model });
    return result();
  }
  if (provider === "custom" && !settings.customProviderUrl) {
    fieldErrors.baseUrl = "自定义供应商必须填写 OpenAI 兼容接口地址。";
    stages.push({ stage: "configuration", ok: false, message: fieldErrors.baseUrl });
    return result();
  }
  if (provider !== "ollama" && provider !== "custom" && !resolveCredential(settings, provider)) {
    fieldErrors.credential = "未配置此供应商的 API 密钥。";
    stages.push({ stage: "configuration", ok: false, message: fieldErrors.credential });
    return result();
  }

  try {
    client = createProvider(settings);
    stages.push({ stage: "configuration", ok: true, message: "配置字段有效，Provider 已创建。" });
  } catch (error) {
    const message = safeError(error);
    classifyFieldError(message, fieldErrors);
    stages.push({ stage: "configuration", ok: false, message });
    return result();
  }

  const connectivityStarted = Date.now();
  try {
    const response = await probeEndpoint(settings, provider);
    stages.push({
      stage: "model_discovery",
      ok: response.ok,
      message: response.message,
      latencyMs: Date.now() - connectivityStarted,
    });
    if (!response.ok) {
      fieldErrors[response.field] = response.message;
      return result();
    }
  } catch (error) {
    const message = safeError(error);
    fieldErrors.network = message;
      stages.push({ stage: "model_discovery", ok: false, message, latencyMs: Date.now() - connectivityStarted });
    return result();
  }

  const chatStarted = Date.now();
  try {
    const message = await runChatProbe(client, settings);
    stages.push({
      stage: "chat",
      ok: message.content.some((block) => block.type === "text" && block.text.trim().length > 0),
      message: "基础流式对话成功并返回文本。",
      latencyMs: Date.now() - chatStarted,
    });
  } catch (error) {
    const message = safeError(error);
    classifyFieldError(message, fieldErrors);
    stages.push({ stage: "chat", ok: false, message, latencyMs: Date.now() - chatStarted });
    return result();
  }

  const toolStarted = Date.now();
  try {
    const probe = await runToolCallProbe(client, settings);
    const message = probe.message;
    const calledTool = message.content.some((block) =>
      block.type === "tool_use" && block.name === "grep"
    );
    if (!calledTool) fieldErrors.model = "模型返回了文本，但没有按要求生成工具调用。";
    stages.push({
      stage: "tool_call",
      ok: calledTool,
      message: calledTool
        ? "模型成功生成结构化工具调用。"
        : fieldErrors.model!,
      latencyMs: Date.now() - toolStarted,
    });
    if (!calledTool) return result();

    const roundtripStarted = Date.now();
    try {
      const final = await runToolResultProbe(client, settings, probe);
      const text = final.content
        .filter((block) => block.type === "text")
        .map((block) => block.type === "text" ? block.text : "")
        .join("");
      const calledAgain = final.content.some((block) => block.type === "tool_use");
      const ok = !calledAgain && text === "ALLYCODE_TOOL_OK";
      if (!ok) {
        fieldErrors.model = calledAgain
          ? "模型收到工具结果后仍重复调用工具，无法可靠完成 Agent 两轮续接。"
          : "模型未在工具结果后返回预期确认文本，Agent 两轮续接未通过。";
      }
      stages.push({
        stage: "tool_result_roundtrip",
        ok,
        message: ok
          ? "工具结果已成功回传，模型完成第二轮确认。"
          : fieldErrors.model!,
        latencyMs: Date.now() - roundtripStarted,
      });
    } catch (error) {
      const message = safeError(error);
      classifyFieldError(message, fieldErrors);
      stages.push({
        stage: "tool_result_roundtrip",
        ok: false,
        message,
        latencyMs: Date.now() - roundtripStarted,
      });
    }
  } catch (error) {
    const message = safeError(error);
    classifyFieldError(message, fieldErrors);
    stages.push({ stage: "tool_call", ok: false, message, latencyMs: Date.now() - toolStarted });
  }
  return result();
}

async function runChatProbe(
  provider: ReturnType<typeof createProvider>,
  settings: AllyCodeSettings,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const handle = provider.stream({
      model: settings.model,
      maxTokens: 128,
      systemPrompt: "You are a provider compatibility probe. Reply briefly.",
      messages: [{
        role: "user",
        content: "Reply with the exact text ALLYCODE_OK.",
      }],
      tools: [],
      signal: controller.signal,
    });
    for await (const _delta of handle.deltas()) { /* consume real stream */ }
    return await handle.finalMessage();
  } finally {
    clearTimeout(timer);
  }
}

const PROBE_TOOL = {
  name: "grep" as const,
  description: "Search text in a local path.",
  input_schema: {
    type: "object" as const,
    properties: { pattern: { type: "string" }, path: { type: "string" } },
    required: ["pattern", "path"],
  },
};

async function runToolCallProbe(
  provider: ReturnType<typeof createProvider>,
  settings: AllyCodeSettings,
): Promise<{ message: NormalizedMessage; user: ConversationMessage }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const user: ConversationMessage = {
    role: "user",
    content: "Call grep with pattern allycode_probe and path dot. Do not answer with text.",
  };
  try {
    const handle = provider.stream({
      model: settings.model,
      maxTokens: 256,
      systemPrompt: "You are a provider compatibility probe. You must call the supplied grep tool exactly once.",
      messages: [user],
      tools: [PROBE_TOOL],
      signal: controller.signal,
    });
    for await (const _delta of handle.deltas()) { /* consume real stream */ }
    return { message: await handle.finalMessage(), user };
  } finally {
    clearTimeout(timer);
  }
}

async function runToolResultProbe(
  provider: ReturnType<typeof createProvider>,
  settings: AllyCodeSettings,
  first: { message: NormalizedMessage; user: ConversationMessage },
): Promise<NormalizedMessage> {
  const toolUse = first.message.content.find((block) => block.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") throw new Error("首轮未返回可续接的工具调用。");
  const assistant: ConversationMessage = {
    role: "assistant",
    providerState: first.message.providerState,
    content: first.message.content.map((block) => block.type === "text"
      ? { type: "text" as const, text: block.text }
      : { type: "tool_use" as const, id: block.id, name: block.name, input: block.input }),
  };
  const result: ConversationMessage = {
    role: "user",
    content: [{
      type: "tool_result",
      tool_use_id: toolUse.id,
      content: "ALLYCODE_PROBE_RESULT",
    }],
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const handle = provider.stream({
      model: settings.model,
      maxTokens: 128,
      systemPrompt: "You are a compatibility probe. After receiving the tool result, do not call tools again and reply exactly ALLYCODE_TOOL_OK.",
      messages: [first.user, assistant, result],
      tools: [{
        name: "grep",
        description: "Search text in a local path.",
        input_schema: {
          type: "object",
          properties: { pattern: { type: "string" }, path: { type: "string" } },
          required: ["pattern", "path"],
        },
      }],
      signal: controller.signal,
    });
    for await (const _delta of handle.deltas()) { /* consume real stream */ }
    return await handle.finalMessage();
  } finally {
    clearTimeout(timer);
  }
}

async function probeEndpoint(
  settings: AllyCodeSettings,
  provider: ProviderName,
): Promise<{ ok: boolean; message: string; field: "credential" | "model" | "network" }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    if (provider === "ollama") {
      const base = (settings.providerBaseUrls?.ollama ?? settings.localModel.serviceUrl ?? "http://127.0.0.1:11434")
        .replace(/\/v1\/?$/, "");
      const response = await fetch(`${base}/api/tags`, { signal: controller.signal });
      return { ok: response.ok, message: response.ok ? "本地模型服务可访问。" : `本地模型服务返回 HTTP ${response.status}。`, field: "network" };
    }
    const baseUrl = provider === "custom"
      ? settings.customProviderUrl!
      : settings.providerBaseUrls?.[provider] ?? PROVIDER_PRESETS[provider]?.baseUrl;
    if (!baseUrl && provider !== "anthropic") throw new Error("未找到供应商接口地址。");
    const credential = resolveCredential(settings, provider);
    const url = provider === "anthropic"
      ? `${(settings.providerBaseUrls?.anthropic ?? "https://api.anthropic.com").replace(/\/$/, "")}/v1/models?limit=1`
      : `${baseUrl!.replace(/\/$/, "")}/models`;
    const response = await fetch(url, {
      headers: provider === "anthropic"
        ? { "x-api-key": credential, "anthropic-version": "2023-06-01" }
        : credential ? { Authorization: `Bearer ${credential}` } : {},
      signal: controller.signal,
    });
    if (response.ok) {
      const payload = await response.json().catch(() => undefined) as unknown;
      const modelIds = extractModelIds(payload);
      const selected = normalizeProviderModelId(provider, settings.model);
      const selectedAvailable = modelIds.length === 0 || modelIds.some((model) =>
        normalizeProviderModelId(provider, model) === selected
      );
      if (!selectedAvailable) {
        const kimiHint = provider === "moonshot" && selected === "kimi-k3"
          ? "Kimi K3 需要开放平台账户完成实际充值后解锁；请刷新列表并选择当前账户可见模型。"
          : "请刷新动态模型列表并选择当前账户可见模型。";
        return {
          ok: false,
          field: "model",
          message: `模型列表读取成功（HTTP ${response.status}），但当前账户不可见所选模型 ${selected}。${kimiHint}`,
        };
      }
      return { ok: true, field: "network", message: `模型列表读取成功（HTTP ${response.status}），所选模型 ${selected} 对当前账户可见。` };
    }
    if (response.status === 404 || response.status === 405) {
      return { ok: true, field: "network", message: `该端点未提供模型列表（HTTP ${response.status}），将继续用实际模型请求验证。` };
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, field: "credential", message: `模型列表凭据验证失败（HTTP ${response.status}）。` };
    }
    return { ok: false, field: "network", message: `供应商模型列表暂不可用（HTTP ${response.status}）。` };
  } finally {
    clearTimeout(timer);
  }
}

function extractModelIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const rows = (payload as { data?: unknown }).data;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    if (typeof row === "string") return [row];
    if (!row || typeof row !== "object") return [];
    const id = (row as { id?: unknown }).id;
    return typeof id === "string" ? [id] : [];
  });
}

function resolveCredential(settings: AllyCodeSettings, provider: ProviderName): string {
  const fields: Partial<Record<ProviderName, keyof AllyCodeSettings>> = {
    anthropic: "apiKey",
    openai: "openaiApiKey",
    deepseek: "deepseekApiKey",
    qwen: "qwenApiKey",
    groq: "groqApiKey",
    gemini: "geminiApiKey",
    openrouter: "openrouterApiKey",
    moonshot: "moonshotApiKey",
    custom: "customProviderKey",
  };
  const configured = fields[provider] ? settings[fields[provider]!] : undefined;
  if (typeof configured === "string" && configured) return configured;
  const env: Partial<Record<ProviderName, string>> = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
    qwen: "DASHSCOPE_API_KEY",
    groq: "GROQ_API_KEY",
    gemini: "GEMINI_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    moonshot: "MOONSHOT_API_KEY",
  };
  return env[provider] ? process.env[env[provider]!] ?? "" : "";
}

function classifyFieldError(
  message: string,
  errors: ProviderTestResult["fieldErrors"],
): void {
  if (/401|403|api key|credential|unauthorized/i.test(message)) errors.credential = message;
  else if (/model|404|not found/i.test(message)) errors.model = message;
  else if (/url|endpoint|fetch|network|timeout|aborted/i.test(message)) errors.network = message;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/aborted/i.test(message)) return "连接或模型响应在 45 秒内未完成。";
  return message.replace(/sk-[A-Za-z0-9_-]+/g, "[已隐藏密钥]").slice(0, 600);
}
