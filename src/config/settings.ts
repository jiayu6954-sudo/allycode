import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { SettingsSchema, type AllyCodeSettings } from "./schema.js";

/**
 * Runtime data location:
 *   1. ALLYCODE_DATA_DIR
 *   2. ~/.allycode
 */
export const DATA_DIR: string = (() => {
  const env = process.env["ALLYCODE_DATA_DIR"];
  if (env?.trim()) return path.resolve(env.trim());
  return path.join(os.homedir(), ".allycode");
})();

export const CONFIG_DIR = DATA_DIR;
export const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
export const SESSIONS_DIR = path.join(DATA_DIR, "sessions");
export const MEMORY_DIR = path.join(DATA_DIR, "memory");
export const LOG_FILE = path.join(DATA_DIR, "debug.log");
const LEGACY_DATA_DIR = path.join(os.homedir(), ".seed");

export async function loadSettings(): Promise<AllyCodeSettings> {
  try {
    const raw = await fs.readFile(SETTINGS_FILE, "utf-8");
    return SettingsSchema.parse(JSON.parse(raw) as unknown);
  } catch {
    return SettingsSchema.parse({});
  }
}

export async function saveSettings(
  partial: Partial<AllyCodeSettings>,
): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  const current = await loadSettings();
  const validated = SettingsSchema.parse(deepMerge(current, partial));
  await writePrivateSettings(validated);
}

/** Replace the complete settings document after validating it. */
export async function replaceSettings(settings: AllyCodeSettings): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await writePrivateSettings(SettingsSchema.parse(settings));
}

export async function resetSettings(): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await writePrivateSettings(SettingsSchema.parse({}));
}

export async function ensureConfigDir(): Promise<void> {
  await migrateLegacyData();
  await Promise.all([
    fs.mkdir(DATA_DIR, { recursive: true }),
    fs.mkdir(SESSIONS_DIR, { recursive: true }),
    fs.mkdir(MEMORY_DIR, { recursive: true }),
  ]);
}

export function applyCliOverrides(
  settings: AllyCodeSettings,
  opts: {
    model?: string;
    maxTokens?: number;
    allowAll?: boolean;
    denyAll?: boolean;
    apiKey?: string;
  },
): AllyCodeSettings {
  const result = structuredClone(settings);
  if (opts.model) result.model = opts.model;
  if (opts.maxTokens) result.maxTokens = opts.maxTokens;
  if (opts.apiKey) result.apiKey = opts.apiKey;

  if (opts.allowAll) {
    result.defaultPermissions = {
      bash: "auto",
      file_write: "auto",
      file_edit: "auto",
      file_read: "auto",
      glob: "auto",
      grep: "auto",
      web_fetch: "auto",
      web_search: "auto",
      session_search: "auto",
      git_commit: "auto",
      spawn_research: "auto",
    };
  }
  if (opts.denyAll) {
    result.defaultPermissions = {
      bash: "deny",
      file_write: "deny",
      file_edit: "deny",
      file_read: "auto",
      glob: "auto",
      grep: "auto",
      web_fetch: "deny",
      web_search: "auto",
      session_search: "auto",
      git_commit: "deny",
      spawn_research: "auto",
    };
  }
  return result;
}

async function writePrivateSettings(settings: AllyCodeSettings): Promise<void> {
  const temporaryFile = `${SETTINGS_FILE}.${process.pid}.tmp`;
  await fs.writeFile(
    temporaryFile,
    JSON.stringify(settings, null, 2),
    { encoding: "utf-8", mode: 0o600 },
  );
  if (process.platform !== "win32") await fs.chmod(temporaryFile, 0o600);
  await fs.rename(temporaryFile, SETTINGS_FILE);
}

async function migrateLegacyData(): Promise<void> {
  if (DATA_DIR === LEGACY_DATA_DIR) return;
  try {
    await fs.access(DATA_DIR);
    return;
  } catch {
    // New data directory does not exist yet.
  }
  try {
    await fs.access(LEGACY_DATA_DIR);
    await fs.cp(LEGACY_DATA_DIR, DATA_DIR, {
      recursive: true,
      errorOnExist: false,
      force: false,
    });
  } catch {
    // No legacy data to migrate, or migration was not possible.
  }
}

function deepMerge<T extends object>(target: T, source: Partial<T>): T {
  const result = { ...target };
  for (const key of Object.keys(source) as Array<keyof T>) {
    const sourceValue = source[key];
    const targetValue = target[key];
    if (
      sourceValue !== undefined &&
      sourceValue !== null &&
      typeof sourceValue === "object" &&
      !Array.isArray(sourceValue) &&
      targetValue !== null &&
      typeof targetValue === "object" &&
      !Array.isArray(targetValue)
    ) {
      result[key] = deepMerge(
        targetValue as object,
        sourceValue as object,
      ) as T[typeof key];
    } else if (sourceValue !== undefined) {
      result[key] = sourceValue as T[typeof key];
    }
  }
  return result;
}
