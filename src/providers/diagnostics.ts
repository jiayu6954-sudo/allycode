import type { AllyCodeSettings } from "../config/schema.js";
import { createProvider, PROVIDER_PRESETS } from "./index.js";
import type { ProviderName } from "./interface.js";

export type ProviderTestStage = "configuration" | "connectivity" | "chat" | "tool_call";

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
}

const PROBE_TIMEOUT_MS = 45_000;

export async function testProviderCompatibility(
  settings: AllyCodeSettings,
): Promise<ProviderTestResult> {
  const provider = settings.provider as ProviderName;
  const stages: ProviderStageResult[] = [];
  const fieldErrors: ProviderTestResult["fieldErrors"] = {};
  const result = (): ProviderTestResult => ({
    provider,
    model: settings.model,
    ok: stages.length === 4 && stages.every((stage) => stage.ok),
    testedAt: new Date().toISOString(),
    stages,
    fieldErrors,
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

  let client;
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
      stage: "connectivity",
      ok: response.reachable,
      message: response.message,
      latencyMs: Date.now() - connectivityStarted,
    });
    if (!response.reachable) {
      fieldErrors.network = response.message;
      return result();
    }
  } catch (error) {
    const message = safeError(error);
    fieldErrors.network = message;
    stages.push({ stage: "connectivity", ok: false, message, latencyMs: Date.now() - connectivityStarted });
    return result();
  }

  const chatStarted = Date.now();
  try {
    const message = await runProbe(client, settings, false);
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
    const message = await runProbe(client, settings, true);
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
  } catch (error) {
    const message = safeError(error);
    classifyFieldError(message, fieldErrors);
    stages.push({ stage: "tool_call", ok: false, message, latencyMs: Date.now() - toolStarted });
  }
  return result();
}

async function runProbe(
  provider: ReturnType<typeof createProvider>,
  settings: AllyCodeSettings,
  toolProbe: boolean,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const handle = provider.stream({
      model: settings.model,
      maxTokens: 128,
      systemPrompt: toolProbe
        ? "You are a provider compatibility probe. You must call the supplied grep tool exactly once."
        : "You are a provider compatibility probe. Reply briefly.",
      messages: [{
        role: "user",
        content: toolProbe
          ? "Call grep with pattern allycode_probe and path dot. Do not answer with text."
          : "Reply with the exact text ALLYCODE_OK.",
      }],
      tools: toolProbe ? [{
        name: "grep",
        description: "Search text in a local path.",
        input_schema: {
          type: "object",
          properties: { pattern: { type: "string" }, path: { type: "string" } },
          required: ["pattern", "path"],
        },
      }] : [],
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
): Promise<{ reachable: boolean; message: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    if (provider === "ollama") {
      const base = (settings.providerBaseUrls?.ollama ?? settings.localModel.serviceUrl ?? "http://127.0.0.1:11434")
        .replace(/\/v1\/?$/, "");
      const response = await fetch(`${base}/api/tags`, { signal: controller.signal });
      return { reachable: response.ok, message: response.ok ? "本地模型服务可访问。" : `本地模型服务返回 HTTP ${response.status}。` };
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
    const reachable = response.status < 500;
    return {
      reachable,
      message: reachable
        ? `接口可达（HTTP ${response.status}）。`
        : `供应商接口暂不可用（HTTP ${response.status}）。`,
    };
  } finally {
    clearTimeout(timer);
  }
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
