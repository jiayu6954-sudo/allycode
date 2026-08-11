import fs from "node:fs/promises";
import path from "node:path";

const expectedVersion = "0.10.0-alpha.8";
const packageDocument = JSON.parse(await fs.readFile("package.json", "utf8"));
const failures = [];

if (packageDocument.version !== expectedVersion) {
  failures.push(`package.json 版本必须是 ${expectedVersion}，当前为 ${packageDocument.version}`);
}

const certificate = process.env.WIN_CSC_LINK?.trim();
const certificatePassword = process.env.WIN_CSC_KEY_PASSWORD?.trim();
if (!certificate) failures.push("缺少 WIN_CSC_LINK（Windows EV/OV 代码签名证书或证书 URL）");
if (!certificatePassword) failures.push("缺少 WIN_CSC_KEY_PASSWORD（证书密码）");

const primary = validateUpdateUrl("ALLYCODE_PRIMARY_UPDATE_URL", failures);
const mirror = validateUpdateUrl("ALLYCODE_MIRROR_UPDATE_URL", failures);
if (primary && mirror && primary === mirror) failures.push("主更新源和备用更新源必须是不同地址");

if (failures.length > 0) {
  console.error("AllyCode 正式发布预检未通过：");
  for (const failure of failures) console.error(`- ${failure}`);
  console.error("\n已中止发布。开发预览仍可使用 npm run desktop:package 构建，但不得对外分发。\n");
  process.exit(1);
}

const releaseDirectory = path.resolve(".release");
await fs.mkdir(releaseDirectory, { recursive: true });
await fs.writeFile(
  path.join(releaseDirectory, "update-sources.json"),
  JSON.stringify({
    schemaVersion: 1,
    channels: {
      stable: [],
      alpha: [primary, mirror],
    },
  }, null, 2),
  { encoding: "utf8", mode: 0o600 },
);
console.log("发布预检通过：签名参数已提供，国内主源和备用源已写入临时构建配置。");

function validateUpdateUrl(name, errors) {
  const value = process.env[name]?.trim().replace(/\/$/, "");
  if (!value) {
    errors.push(`缺少 ${name}`);
    return undefined;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") errors.push(`${name} 必须使用 HTTPS`);
    if (/example\.|invalid|localhost/i.test(url.hostname)) errors.push(`${name} 不能使用示例或本机地址`);
    return url.toString().replace(/\/$/, "");
  } catch {
    errors.push(`${name} 不是有效 URL`);
    return undefined;
  }
}
