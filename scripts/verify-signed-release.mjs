import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const releaseDirectory = path.resolve("release", "alpha.9");
const entries = await fs.readdir(releaseDirectory, { withFileTypes: true });
const executables = entries
  .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".exe"))
  .map((entry) => path.join(releaseDirectory, entry.name));

if (executables.length < 2) {
  throw new Error("签名验证失败：未同时找到 NSIS 安装包和便携版。");
}

const manifest = [];
for (const executable of executables) {
  const command = `(Get-AuthenticodeSignature -LiteralPath '${executable.replaceAll("'", "''")}').Status.ToString()`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
  });
  const status = result.stdout.trim();
  if (result.status !== 0 || status !== "Valid") {
    throw new Error(`签名验证失败：${path.basename(executable)} 状态为 ${status || result.stderr.trim() || "未知"}`);
  }
  const content = await fs.readFile(executable);
  manifest.push({
    file: path.basename(executable),
    bytes: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
    authenticode: status,
  });
}

if (!entries.some((entry) => /^latest.*\.yml$/i.test(entry.name))) {
  throw new Error("更新通道验证失败：没有生成 latest*.yml 元数据。");
}

await fs.writeFile(
  path.join(releaseDirectory, "SHA256SUMS.json"),
  JSON.stringify({ version: "0.10.0-alpha.9", generatedAt: new Date().toISOString(), files: manifest }, null, 2),
  "utf8",
);
console.log(`签名验证通过，共验证 ${manifest.length} 个可执行文件；SHA-256 清单已生成。`);
