import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsSchema } from "../src/config/schema.js";
import {
  CredentialVault,
  extractCredentials,
  hydrateCredentials,
  type SecretCryptography,
} from "../desktop/credential-vault.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })
  ));
});

describe("CredentialVault", () => {
  it("never writes credentials as plaintext and can restore them", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "allycode-vault-"));
    temporaryDirectories.push(directory);
    const file = path.join(directory, "credentials.secure.json");
    const vault = new CredentialVault(file, fakeCryptography());
    await vault.initialize();
    await vault.setMany({ deepseek: "sk-private-value", github: "ghp-private-value" });

    const disk = await fs.readFile(file, "utf8");
    expect(disk).not.toContain("sk-private-value");
    expect(disk).not.toContain("ghp-private-value");
    expect(await vault.getAll()).toEqual({
      deepseek: "sk-private-value",
      github: "ghp-private-value",
    });
  });

  it("extracts nested legacy secrets and hydrates runtime settings", () => {
    const settings = SettingsSchema.parse({
      deepseekApiKey: "sk-deepseek",
      search: { tavilyApiKey: "tvly-secret" },
      github: { token: "ghp-secret" },
    });
    const { publicSettings, credentials } = extractCredentials(settings);

    expect(credentials).toMatchObject({
      deepseek: "sk-deepseek",
      tavily: "tvly-secret",
      github: "ghp-secret",
    });
    expect(publicSettings.deepseekApiKey).toBeUndefined();
    expect(publicSettings.search.tavilyApiKey).toBeUndefined();
    expect(publicSettings.github.token).toBeUndefined();
    expect(hydrateCredentials(publicSettings, credentials).deepseekApiKey).toBe("sk-deepseek");
  });

  it("fails closed when operating-system encryption is unavailable", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "allycode-vault-"));
    temporaryDirectories.push(directory);
    const crypto = fakeCryptography();
    crypto.isAvailable = async () => false;
    const vault = new CredentialVault(path.join(directory, "vault.json"), crypto);
    await expect(vault.initialize()).rejects.toThrow("拒绝以明文保存");
  });
});

function fakeCryptography(): SecretCryptography {
  return {
    isAvailable: async () => true,
    backend: () => "test",
    encrypt: async (value) => Buffer.from([...value].reverse().join(""), "utf8"),
    decrypt: async (value) => ({
      value: [...value.toString("utf8")].reverse().join(""),
      shouldReEncrypt: false,
    }),
  };
}
