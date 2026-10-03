import fs from "node:fs/promises";
import path from "node:path";

const releaseDirectory = path.resolve("release", "alpha.9");
const origins = [
  ["国内主源", process.env.ALLYCODE_PRIMARY_PUBLISH_URL, process.env.ALLYCODE_PRIMARY_PUBLISH_TOKEN],
  ["国内备用源", process.env.ALLYCODE_MIRROR_PUBLISH_URL, process.env.ALLYCODE_MIRROR_PUBLISH_TOKEN],
];

for (const [name, value] of origins) {
  if (!value) throw new Error(`缺少 ${name}发布地址环境变量。`);
  const parsed = new URL(value);
  if (parsed.protocol !== "https:") throw new Error(`${name}必须使用 HTTPS。`);
}

const entries = await fs.readdir(releaseDirectory, { withFileTypes: true });
const uploadNames = entries
  .filter((entry) => entry.isFile() && (/\.exe$/i.test(entry.name) || /\.blockmap$/i.test(entry.name) || /^latest.*\.yml$/i.test(entry.name) || entry.name === "SHA256SUMS.json"))
  .map((entry) => entry.name);
if (!uploadNames.some((name) => /^latest.*\.yml$/i.test(name))) throw new Error("缺少 latest.yml，拒绝发布不完整更新通道。");
if (!uploadNames.some((name) => /\.exe$/i.test(name))) throw new Error("缺少 Windows 安装包，拒绝发布。");

for (const [originName, originValue, token] of origins) {
  const base = originValue.replace(/\/$/, "");
  for (const name of uploadNames) {
    const body = await fs.readFile(path.join(releaseDirectory, name));
    const response = await fetch(`${base}/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: {
        "content-type": contentType(name),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body,
    });
    if (!response.ok) throw new Error(`${originName}上传 ${name} 失败：HTTP ${response.status}`);
    console.log(`${originName}：已上传 ${name}`);
  }
}

console.log(`国内双源发布完成，共上传 ${uploadNames.length} 个文件到两个独立源。`);

function contentType(name) {
  if (/\.yml$/i.test(name)) return "text/yaml; charset=utf-8";
  if (/\.json$/i.test(name)) return "application/json";
  return "application/octet-stream";
}
