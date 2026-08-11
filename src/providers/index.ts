import type { AIProvider, ProviderName, ProviderStreamHandle, StreamParams, NormalizedDelta, NormalizedMessage } from "./interface.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAICompatibleProvider, PROVIDER_PRESETS } from "./openai-compatible.js";
import { SmartLocalProvider, discoverLocalModel } from "./local.js";
import type { DevAISettings } from "../types/config.js";

export { AnthropicProvider } from "./anthropic.js";
export { OpenAICompatibleProvider, PROVIDER_PRESETS } from "./openai-compatible.js";
export { SmartLocalProvider, discoverLocalModel } from "./local.js";
export type { AIProvider, NormalizedMessage, NormalizedBlock, NormalizedDelta, ProviderName } from "./interface.js";

/**
 * Create the appropriate AI provider based on settings + environment.
 *
 * Provider priority for API key resolution:
 *   1. settings.apiKey / settings.deepseekApiKey / etc.
 *   2. CLI --api-key flag (passed via envApiKey)
 *   3. Environment variables (ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, etc.)
 */
export function createProvider(
  settings: DevAISettings,
  envApiKey?: string
): AIProvider {
  const providerName: ProviderName = (settings.provider ?? "anthropic") as ProviderName;

  // ── Anthropic ──────────────────────────────────────────────────────────────
  if (providerName === "anthropic") {
    const key =
      settings.apiKey ??
      envApiKey ??
      process.env["ANTHROPIC_API_KEY"] ??
      "";
    if (!key) throw new MissingKeyError("anthropic", "ANTHROPIC_API_KEY");
    return new AnthropicProvider(key, settings.providerBaseUrls?.anthropic);
  }

  // ── Custom (user-defined OAI-compatible endpoint) ─────────────────────────
  if (providerName === "custom") {
    const url = settings.customProviderUrl;
    if (!url) throw new Error("provider=custom requires customProviderUrl in settings.");
    const key = settings.customProviderKey ?? envApiKey ?? "";
    return new OpenAICompatibleProvider(url, key, "custom");
  }

  // ── Ollama / local — smart provider with auto-discovery + XML fallback ────
  if (providerName === "ollama") {
    // SmartLocalProvider is async (needs probe), so we return a lazy wrapper
    // that discovers and delegates on first stream() call.
    return new LazyLocalProvider(
      settings.providerBaseUrls?.[providerName] ??
      settings.localModel?.serviceUrl ??
      settings.customProviderUrl,
      settings.model,
    );
  }

  // ── All other OAI-compatible providers ───────────────────────────────────
  const preset = PROVIDER_PRESETS[providerName];
  if (!preset) throw new Error(`Unknown provider: "${providerName}"`);

  const key = resolveKey(settings, providerName, envApiKey, preset.envKey);
  if (!key) throw new MissingKeyError(providerName, preset.envKey);

  return new OpenAICompatibleProvider(
    settings.providerBaseUrls?.[providerName] ?? preset.baseUrl,
    key,
    providerName,
    preset.maxTokensLimit,
    preset.maxTokensParameter,
  );
}

/** Get the default model for a given provider */
export function defaultModelForProvider(providerName: ProviderName): string {
  if (providerName === "anthropic") return "claude-sonnet-4-6";
  return PROVIDER_PRESETS[providerName]?.defaultModel ?? "gpt-4o";
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveKey(
  settings: DevAISettings,
  provider: string,
  envApiKey: string | undefined,
  envVarName: string
): string {
  // Settings field (named by provider, e.g. settings.deepseekApiKey)
  const keyField = `${provider}ApiKey` as keyof DevAISettings;
  const settingsKey = settings[keyField];
  if (typeof settingsKey === "string" && settingsKey) return settingsKey;

  // CLI --api-key flag
  if (envApiKey) return envApiKey;

  // Environment variable
  return process.env[envVarName] ?? "";
}

/**
 * Lazy wrapper: SmartLocalProvider requires async probing (discoverLocalModel).
 * This class defers discovery to the first stream() call so createProvider()
 * can remain synchronous.
 */
class LazyLocalProvider implements AIProvider {
  readonly providerName: ProviderName = "ollama";
  private inner: SmartLocalProvider | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(
    private readonly customUrl: string | undefined,
    private readonly model: string,
  ) {}

  private async init(): Promise<void> {
    const caps = await discoverLocalModel(this.customUrl, this.model);
    if (!caps) {
      throw new Error(
        `No local model service found. ` +
        `Start Ollama (ollama serve) or set customProviderUrl in settings.\n` +
        `Checked: Ollama :11434, LM Studio :1234, llama.cpp :8080, vLLM :8000`
      );
    }
    this.inner = new SmartLocalProvider(caps, this.model);
  }

  stream(params: StreamParams): ProviderStreamHandle {
    // Return a handle whose deltas/finalMessage await init internally
    return new LazyStreamHandle(
      this.initPromise ??= this.init(),
      () => this.inner!,
      params,
    );
  }
}

class LazyStreamHandle implements ProviderStreamHandle {
  // Inner handle created once after init — shared by deltas() and finalMessage()
  private innerHandle: ProviderStreamHandle | null = null;

  constructor(
    private readonly initPromise: Promise<void>,
    private readonly getInner: () => SmartLocalProvider,
    private readonly params: StreamParams,
  ) {}

  private getHandle(): ProviderStreamHandle {
    if (!this.innerHandle) {
      this.innerHandle = this.getInner().stream(this.params);
    }
    return this.innerHandle;
  }

  async *deltas(): AsyncIterable<NormalizedDelta> {
    await this.initPromise;
    yield* this.getHandle().deltas();
  }

  async finalMessage(): Promise<NormalizedMessage> {
    await this.initPromise;
    return this.getHandle().finalMessage();
  }
}

class MissingKeyError extends Error {
  constructor(provider: string, envVar: string) {
    super(
      `API key not set for provider "${provider}".\n` +
      `  Run:  allycode setup\n` +
      (envVar ? `  Or:   export ${envVar}=your-key\n` : "") +
      `  Or:   allycode --api-key your-key "prompt"`
    );
    this.name = "MissingKeyError";
  }
}
