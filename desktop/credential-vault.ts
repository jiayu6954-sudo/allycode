import fs from "node:fs/promises";
import path from "node:path";
import type { AllyCodeSettings } from "../src/config/schema.js";

export const CREDENTIAL_PATHS = {
  anthropic: ["apiKey"],
  openai: ["openaiApiKey"],
  deepseek: ["deepseekApiKey"],
  qwen: ["qwenApiKey"],
  groq: ["groqApiKey"],
  gemini: ["geminiApiKey"],
  openrouter: ["openrouterApiKey"],
  moonshot: ["moonshotApiKey"],
  custom: ["customProviderKey"],
  tavily: ["search", "tavilyApiKey"],
  brave: ["search", "braveApiKey"],
  serper: ["search", "serperApiKey"],
  github: ["github", "token"],
} as const;

export type CredentialId = keyof typeof CREDENTIAL_PATHS;
export type CredentialValues = Partial<Record<CredentialId, string>>;

export interface SecretCryptography {
  isAvailable(): Promise<boolean>;
  encrypt(value: string): Promise<Buffer>;
  decrypt(value: Buffer): Promise<{ value: string; shouldReEncrypt: boolean }>;
  backend(): string;
}

interface VaultDocument {
  version: 1;
  backend: string;
  updatedAt: string;
  entries: Partial<Record<CredentialId, string>>;
}

export class CredentialVault {
  constructor(
    private readonly filePath: string,
    private readonly cryptography: SecretCryptography,
  ) {}

  async initialize(): Promise<void> {
    if (!(await this.cryptography.isAvailable())) {
      throw new Error("操作系统安全密钥库不可用，AllyCode 已拒绝以明文保存 API 密钥。");
    }
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
  }

  async getAll(): Promise<CredentialValues> {
    const document = await this.readDocument();
    const result: CredentialValues = {};
    const rotated: CredentialValues = {};
    for (const [id, encoded] of Object.entries(document.entries)) {
      if (!encoded || !isCredentialId(id)) continue;
      const decrypted = await this.cryptography.decrypt(Buffer.from(encoded, "base64"));
      result[id] = decrypted.value;
      if (decrypted.shouldReEncrypt) rotated[id] = decrypted.value;
    }
    if (Object.keys(rotated).length > 0) await this.setMany(rotated);
    return result;
  }

  async setMany(values: CredentialValues): Promise<void> {
    if (Object.keys(values).length === 0) return;
    const document = await this.readDocument();
    for (const [id, value] of Object.entries(values)) {
      if (!isCredentialId(id)) continue;
      const normalized = value?.trim();
      if (!normalized) {
        delete document.entries[id];
        continue;
      }
      document.entries[id] = (await this.cryptography.encrypt(normalized)).toString("base64");
    }
    document.backend = this.cryptography.backend();
    document.updatedAt = new Date().toISOString();
    await this.writeDocument(document);
  }

  async has(id: CredentialId): Promise<boolean> {
    const document = await this.readDocument();
    return Boolean(document.entries[id]);
  }

  private async readDocument(): Promise<VaultDocument> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8")) as VaultDocument;
      if (parsed.version !== 1 || typeof parsed.entries !== "object") {
        throw new Error("不支持的安全密钥库格式。");
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return {
        version: 1,
        backend: this.cryptography.backend(),
        updatedAt: new Date().toISOString(),
        entries: {},
      };
    }
  }

  private async writeDocument(document: VaultDocument): Promise<void> {
    const temporaryFile = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporaryFile, JSON.stringify(document, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    if (process.platform !== "win32") await fs.chmod(temporaryFile, 0o600);
    await fs.rename(temporaryFile, this.filePath);
  }
}

export function extractCredentials<T extends object>(input: T): {
  publicSettings: T;
  credentials: CredentialValues;
} {
  const publicSettings = structuredClone(input);
  const credentials: CredentialValues = {};
  for (const [id, credentialPath] of Object.entries(CREDENTIAL_PATHS) as Array<
    [CredentialId, readonly string[]]
  >) {
    const value = getAtPath(publicSettings, credentialPath);
    if (typeof value === "string") credentials[id] = value.trim();
    deleteAtPath(publicSettings, credentialPath);
  }
  return { publicSettings, credentials };
}

export function hydrateCredentials(
  settings: AllyCodeSettings,
  credentials: CredentialValues,
): AllyCodeSettings {
  const hydrated = structuredClone(settings);
  for (const [id, value] of Object.entries(credentials) as Array<[CredentialId, string]>) {
    if (value) setAtPath(hydrated, CREDENTIAL_PATHS[id], value);
  }
  return hydrated;
}

function isCredentialId(value: string): value is CredentialId {
  return value in CREDENTIAL_PATHS;
}

function getAtPath(target: object, keys: readonly string[]): unknown {
  let current: unknown = target;
  for (const key of keys) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function deleteAtPath(target: object, keys: readonly string[]): void {
  let current = target as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) {
    const next = current[key];
    if (!next || typeof next !== "object") return;
    current = next as Record<string, unknown>;
  }
  delete current[keys.at(-1)!];
}

function setAtPath(target: object, keys: readonly string[], value: string): void {
  let current = target as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) {
    const next = current[key];
    if (!next || typeof next !== "object") current[key] = {};
    current = current[key] as Record<string, unknown>;
  }
  current[keys.at(-1)!] = value;
}
