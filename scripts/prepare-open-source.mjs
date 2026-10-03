import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const packageDocument = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
const packageName = `allycode-${packageDocument.version}`;
const exportRoot = path.join(projectRoot, "open-source");
const targetRoot = path.join(exportRoot, packageName);

if (!targetRoot.startsWith(`${exportRoot}${path.sep}`)) {
  throw new Error("Open-source export target escaped its staging directory.");
}

const rootFiles = [
  ".gitignore",
  ".gitattributes",
  ".dockerignore",
  "account-service.json",
  "THIRD_PARTY_NOTICES.md",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "electron-builder.release.yml",
  "eslint.config.js",
  "package-lock.json",
  "package.json",
  "tsconfig.json",
  "tsup.config.ts",
  "update-sources.json",
  "vitest.config.ts",
];

const publicDirectories = [".github", "benchmarks", "desktop", "src", "test", "deploy/accounts", "skill/sources-to-excel-complete/sources-to-excel"];
// Explicit allowlist: machine maintenance scripts must never enter a public release.
const publicScripts = [
  "add-shebang.mjs", "audit-agent-monitor.ts", "benchmark-vision-ocr.ts",
  "build-accounts.mjs", "build-provenance.mjs", "capture-desktop-ui.mjs",
  "clean-desktop.mjs", "download-vision-qwen.ts", "generate-icon.mjs",
  "h0-dpapi-runner.cjs", "install-vision.ts", "launch-allycode.ps1",
  "monitor-run.mjs", "monitor-snapshot.mjs", "package-local.mjs",
  "package-open-source.ps1", "preflight-release.mjs", "prepare-open-source.mjs",
  "publish-update-channel.mjs", "setup-formula-tests.ts", "verify-document-live.ts",
  "verify-local-package.mjs", "verify-signed-release.mjs", "verify-vision-live.ts",
  "verify-vision-understanding.ts", "write-launch-manifest.mjs",
];
const blockedDirectories = new Set([
  ".git", ".tmp", "node_modules", "__pycache__", ".venv", "audits",
  ".challenge-results", ".allycode-eval", "dist", "dist-desktop", "release",
]);
const publicDocs = [
  "docs/ARCHITECTURE.md",
  "docs/AGENT_PLATFORM_ARCHITECTURE.md",
  "docs/AGENT_MONITOR.md",
  "docs/ACCOUNT_SERVICE.md",
  "docs/LINUX_SETUP.md",
  "docs/PUBLIC_RELEASE.md",
];

const blockedNames = new Set([
  ".env",
  "API.txt",
  "CLAUDE.md",
  "DEPLOY.md",
  "EVALUATION_REPORT.md",
  "LEARNINGS.md",
  "MEMORY.md",
  "OPERATIONS.md",
  "WHITEPAPER.md",
  "AllyCode_优化需求提示词.md",
]);

const blockedExtensions = new Set([
  ".exe", ".key", ".log", ".map", ".mov", ".mp4", ".pem", ".pfx",
  ".sqlite", ".sqlite-shm", ".sqlite-wal", ".zip", ".db", ".pyc",
  ".gguf", ".safetensors", ".pt", ".pth", ".onnx", ".msi", ".deb", ".appimage",
  ".ttf", ".otf", ".woff", ".woff2",
]);

// Fail closed instead of deleting a previous export or an accidental Git checkout.
try {
  await fs.lstat(targetRoot);
  throw new Error(`Export already exists; move it aside after review: ${targetRoot}`);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
await fs.mkdir(targetRoot, { recursive: true });

for (const relativePath of [...rootFiles, ...publicDocs, ...publicScripts.map(name => `scripts/${name}`)]) {
  await copyPublicFile(relativePath);
}
for (const directory of publicDirectories) {
  await copyPublicDirectory(directory);
}

const files = await listFiles(targetRoot);
const findings = [];
const secretRules = [
  ["GitHub token", /gh[pousr]_[A-Za-z0-9]{20,}/g],
  ["AWS access key", /(?:AKIA|ASIA)[A-Z0-9]{16}/g],
  ["Google API key", /AIza[A-Za-z0-9_-]{35}/g],
  ["GitHub fine-grained token", /github_pat_[A-Za-z0-9_]{20,}/g],
  ["private key material", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ["credential embedded in GitHub URL", /https:\/\/[^/\s@]+@github\.com/gi],
  ["provider-style secret", /(?:sk|tvly)-[A-Za-z0-9_-]{24,}/g],
  ["local private workspace path", /(?:D:\\claude\\devai|C:\\Users\\Administrator)/gi],
];

for (const file of files) {
  const content = await fs.readFile(file);
  if (content.includes(0)) continue;
  const text = content.toString("utf8");
  for (const [label, pattern] of secretRules) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) findings.push(`${label}: ${relativeToTarget(file)}`);
  }
}

if (findings.length > 0) {
  throw new Error(`Public export failed secret/privacy scan:\n${findings.join("\n")}`);
}

const manifestFiles = [];
for (const file of files) {
  const content = await fs.readFile(file);
  manifestFiles.push({
    path: relativeToTarget(file),
    bytes: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
  });
}
manifestFiles.sort((left, right) => left.path.localeCompare(right.path));

await fs.writeFile(
  path.join(targetRoot, "OPEN_SOURCE_MANIFEST.json"),
  JSON.stringify({
    name: "AllyCode",
    version: packageDocument.version,
    license: packageDocument.license,
    generatedAt: new Date().toISOString(),
    fileCount: manifestFiles.length,
    files: manifestFiles,
    excludedCategories: [
      "credentials and environment files",
      "private whitepaper and internal workflow documents",
      "local runtime data, conversations, memory, logs, and databases",
      "build products, installers, screenshots, and test artifacts",
      "third-party reference source trees and datasets",
      "Git metadata and local authentication configuration",
    ],
  }, null, 2),
  "utf8",
);

console.log(`Public source staging created: ${targetRoot}`);
console.log(`Files: ${manifestFiles.length + 1}`);
console.log("Privacy/secret scan: passed");

async function copyPublicDirectory(relativeDirectory) {
  const sourceDirectory = path.join(projectRoot, relativeDirectory);
  for (const entry of await fs.readdir(sourceDirectory, { withFileTypes: true })) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory() && !blockedDirectories.has(entry.name)) await copyPublicDirectory(relativePath);
    else if (entry.isFile()) await copyPublicFile(relativePath);
  }
}

async function copyPublicFile(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/");
  const baseName = path.basename(relativePath);
  const extension = path.extname(relativePath).toLowerCase();
  if (blockedNames.has(baseName) || blockedExtensions.has(extension)) return;
  if (baseName.startsWith(".env.") && baseName !== ".env.example") return;
  if (normalized.endsWith("/TEST_RECORD.md")) return;
  if (normalized === ".github/CONTRIBUTING.md") return;

  const source = path.join(projectRoot, relativePath);
  const destination = path.join(targetRoot, relativePath);
  if (!source.startsWith(`${projectRoot}${path.sep}`) || !destination.startsWith(`${targetRoot}${path.sep}`)) {
    throw new Error(`Refusing unsafe public export path: ${relativePath}`);
  }
  const info = await fs.lstat(source);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Not a regular public file: ${normalized}`);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
}

async function listFiles(directory) {
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(entryPath));
    else if (entry.isFile()) result.push(entryPath);
  }
  return result;
}

function relativeToTarget(file) {
  return path.relative(targetRoot, file).replaceAll("\\", "/");
}
