import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import { SettingsSchema, type AllyCodeSettings } from "../../config/schema.js";

const PROVIDERS: Array<{
  provider: AllyCodeSettings["provider"];
  model: string;
  label: string;
}> = [
  { provider: "anthropic", model: "claude-sonnet-4-6", label: "Anthropic Claude" },
  { provider: "openai", model: "gpt-4.1", label: "OpenAI" },
  { provider: "deepseek", model: "deepseek-chat", label: "DeepSeek" },
  { provider: "qwen", model: "qwen3-coder-plus", label: "阿里云通义千问 / Qwen" },
  { provider: "groq", model: "llama-3.3-70b-versatile", label: "Groq" },
  { provider: "gemini", model: "gemini-2.5-pro", label: "Google Gemini" },
  { provider: "openrouter", model: "anthropic/claude-sonnet-4", label: "OpenRouter" },
  { provider: "ollama", model: "qwen2.5-coder:7b", label: "Ollama / local" },
  { provider: "moonshot", model: "kimi-k2", label: "Moonshot / Kimi" },
  { provider: "custom", model: "custom-model", label: "Custom OpenAI-compatible" },
];

export function configCommand(): Command {
  const cmd = new Command("config").description("Manage AllyCode settings");

  cmd
    .command("show")
    .description("Show current settings or storage usage")
    .option("--storage", "Show storage usage and quota status")
    .option("--json", "Print machine-readable JSON")
    .action(async (opts: { storage?: boolean; json?: boolean }) => {
      if (opts.storage) {
        const { getStorageStats } = await import("../../storage/guard.js");
        const stats = await getStorageStats();
        if (opts.json) {
          console.log(JSON.stringify(stats, null, 2));
        } else {
          console.log(`Data directory: ${stats.dataDir}`);
          console.log(`Total: ${formatBytes(stats.totalBytes)} / ${formatBytes(stats.maxBytes)}`);
          console.log(`Sessions: ${stats.sessionCount} / ${stats.maxSessions} (${formatBytes(stats.sessionBytes)})`);
          console.log(`Log: ${formatBytes(stats.logBytes)} / ${formatBytes(stats.maxLogBytes)}`);
          console.log(`Vectors: ${formatBytes(stats.vectorBytes)} / ${formatBytes(stats.maxVectorBytes)}`);
        }
        return;
      }
      const { loadSettings, SETTINGS_FILE } = await import("../../config/settings.js");
      const settings = await loadSettings();
      if (!opts.json) console.log(`Settings file: ${SETTINGS_FILE}\n`);
      console.log(JSON.stringify(redactSettings(settings), null, 2));
    });

  cmd
    .command("set <key> <value>")
    .description("Set a value using a dotted key, e.g. ui.theme or sandbox.enabled")
    .action(async (key: string, value: string) => {
      const { loadSettings, saveSettings } = await import("../../config/settings.js");
      const current = await loadSettings();
      const next = structuredClone(current) as Record<string, unknown>;
      setNestedValue(next, key, parseValue(value));
      const validated = SettingsSchema.parse(next);
      await saveSettings(validated);
      console.log(`Updated: ${key} = ${JSON.stringify(readNestedValue(validated, key))}`);
    });

  cmd
    .command("model")
    .description("Select the provider and default model")
    .option("-p, --provider <provider>", "Provider name")
    .option("-m, --model <model>", "Model identifier")
    .action(async (opts: { provider?: string; model?: string }) => {
      const { loadSettings, saveSettings } = await import("../../config/settings.js");
      let selection = PROVIDERS.find((item) => item.provider === opts.provider);
      if (opts.provider && !selection) {
        throw new Error(`Unsupported provider: ${opts.provider}`);
      }
      let model = opts.model;

      if (!selection && process.stdin.isTTY && process.stdout.isTTY) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          console.log(PROVIDERS.map((item, index) =>
            `${index + 1}) ${item.label} — ${item.model}`
          ).join("\n"));
          const answer = await rl.question("Choose provider [1]: ");
          const index = Math.max(0, Number.parseInt(answer || "1", 10) - 1);
          selection = PROVIDERS[index] ?? PROVIDERS[0]!;
          model = (await rl.question(`Model [${selection.model}]: `)).trim() || selection.model;
        } finally {
          rl.close();
        }
      }

      const current = await loadSettings();
      const finalSelection =
        selection ??
        PROVIDERS.find((item) => item.provider === current.provider) ??
        PROVIDERS[0]!;
      model ??= opts.provider ? finalSelection.model : current.model;
      await saveSettings({ provider: finalSelection.provider, model });
      console.log(`Model: ${finalSelection.provider} / ${model}`);
    });

  cmd
    .command("reset")
    .description("Reset all settings to safe defaults")
    .option("--yes", "Skip confirmation")
    .action(async (opts: { yes?: boolean }) => {
      if (!opts.yes && process.stdin.isTTY) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          const answer = await rl.question("Reset all AllyCode settings? [y/N] ");
          if (!/^y(es)?$/i.test(answer.trim())) {
            console.log("Cancelled.");
            return;
          }
        } finally {
          rl.close();
        }
      } else if (!opts.yes) {
        throw new Error("Use --yes when resetting in non-interactive mode.");
      }
      const { resetSettings } = await import("../../config/settings.js");
      await resetSettings();
      console.log("Settings reset to defaults.");
    });

  cmd
    .command("test")
    .description("Run real provider connectivity, chat, and tool-call checks")
    .option("-p, --provider <provider>", "Provider name")
    .option("-m, --model <model>", "Free-form model identifier")
    .option("--json", "Print machine-readable JSON")
    .action(async (opts: { provider?: string; model?: string; json?: boolean }) => {
      const { loadSettings } = await import("../../config/settings.js");
      const { testProviderCompatibility } = await import("../../providers/diagnostics.js");
      const current = await loadSettings();
      const candidate = SettingsSchema.parse({
        ...current,
        provider: opts.provider ?? current.provider,
        model: opts.model ?? current.model,
      });
      const result = await testProviderCompatibility(candidate);
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`${result.provider} / ${result.model}`);
        for (const stage of result.stages) {
          console.log(`${stage.ok ? "✓" : "✗"} ${stage.stage}: ${stage.message}${stage.latencyMs === undefined ? "" : ` (${stage.latencyMs} ms)`}`);
        }
      }
      if (!result.ok) process.exitCode = 1;
    });

  return cmd;
}

export function parseValue(value: string): unknown {
  const trimmed = value.trim();
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === "true";
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed === "null") return null;
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    return JSON.parse(trimmed) as unknown;
  }
  return value;
}

export function setNestedValue(
  target: Record<string, unknown>,
  dottedKey: string,
  value: unknown,
): void {
  const parts = dottedKey.split(".").filter(Boolean);
  if (parts.length === 0 || parts.some((part) => !/^[A-Za-z][\w-]*$/.test(part))) {
    throw new Error(`Invalid settings key: ${dottedKey}`);
  }
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    const current = cursor[part];
    if (current === undefined) cursor[part] = {};
    else if (!current || typeof current !== "object" || Array.isArray(current)) {
      throw new Error(`Cannot set nested value below non-object key: ${part}`);
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts.at(-1)!] = value;
}

function readNestedValue(target: unknown, dottedKey: string): unknown {
  return dottedKey.split(".").reduce<unknown>((cursor, part) => {
    if (!cursor || typeof cursor !== "object") return undefined;
    return (cursor as Record<string, unknown>)[part];
  }, target);
}

function redactSettings(settings: AllyCodeSettings): Record<string, unknown> {
  const copy = structuredClone(settings) as Record<string, unknown>;
  redactSecrets(copy);
  return copy;
}

function redactSecrets(value: Record<string, unknown>): void {
  for (const [key, item] of Object.entries(value)) {
    if (/key|token/i.test(key) && typeof item === "string") value[key] = "***";
    else if (item && typeof item === "object" && !Array.isArray(item)) {
      redactSecrets(item as Record<string, unknown>);
    }
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
