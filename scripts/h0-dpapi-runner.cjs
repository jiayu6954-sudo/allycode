/**
 * H0 canary runner backed by the Windows DPAPI credential vault.
 *
 * Runs as an Electron main process because that is the only place the app's
 * safeStorage key can be decrypted. The plaintext key exists as a local
 * variable and is handed straight to the harness function — it is never a
 * command-line argument, never an environment variable, never logged, and
 * never written to the artifact.
 *
 *   npm run h0:canary:vault -- --approved
 */
const { app, safeStorage } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const BUILT_HARNESS = path.join(".tmp", "h0", "h0-canary.js");

function fail(message) {
  process.stdout.write(`${message}\n`);
  app.exit(2);
}

app.setPath("userData", path.join(process.env.APPDATA ?? "", "@jiayu6954", "allycode"));

app.whenReady().then(async () => {
  const out = (line) => process.stdout.write(`${line}\n`);
  try {
    if (!process.argv.includes("--approved")) {
      return fail("H0 会真实调用付费 API。确认预算后再加 --approved 运行。");
    }
    if (!fs.existsSync(BUILT_HARNESS)) {
      return fail(`缺少已构建的 harness：${BUILT_HARNESS}\n请先执行 npm run h0:build`);
    }
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
      return fail("操作系统密钥库不可用，无法解密保险库。");
    }

    const vaultPath = path.join(os.homedir(), ".allycode", "credentials.secure.json");
    const vault = JSON.parse(fs.readFileSync(vaultPath, "utf8"));
    const encoded = vault.entries && vault.entries.deepseek;
    if (!encoded) return fail("保险库中没有 deepseek 凭据。");

    const decrypted = await safeStorage.decryptStringAsync(Buffer.from(encoded, "base64"));
    // Local only. Not assigned to process.env, not passed through argv.
    const apiKey = decrypted.result;
    if (typeof apiKey !== "string" || apiKey.length === 0) {
      return fail("保险库解密结果为空。");
    }
    out(`凭据来源：Windows DPAPI 保险库（进程内解密，长度 ${apiKey.length}）`);

    const harness = await import(pathToFileURL(path.resolve(BUILT_HARNESS)).href);
    const model = "deepseek-v4-pro";
    const baseUrl = "https://api.deepseek.com/v1";

    const report = await harness.runH0Canary({
      apiKey,
      model,
      baseUrl,
      readBalance: () => harness.readBalances(baseUrl, apiKey),
      listModels: () => harness.listModelIds(baseUrl, apiKey),
    });

    const target = harness.writeH0Report(report);
    out(harness.renderH0Report(report));
    out(`\nartifact: ${target}`);
    out(`harness:  ${harness.harnessHash()}`);
    app.exit(report.verdict === "PASS" ? 0 : 1);
  } catch (error) {
    // Route through the harness redactor when it is loaded; otherwise be
    // conservative and print nothing that could carry a credential.
    const message = error && error.message ? String(error.message) : String(error);
    out(`运行失败：${message.replace(/sk-[A-Za-z0-9_-]{4,}/g, "sk-***").slice(0, 300)}`);
    app.exit(1);
  }
});
