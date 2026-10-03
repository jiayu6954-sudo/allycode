import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();

export async function runStaticChecks() {
  const files = await walk(root);
  const implementation = files.filter((file) => /\.(?:rs|ts|tsx|js|jsx|mjs)$/i.test(file));
  const tests = implementation.filter((file) => /(?:test|spec)/i.test(path.basename(file)) || /[\\/](?:test|tests)[\\/]/i.test(file));
  const packageJson = await readJson(path.join(root, "package.json"));
  const startCommand = String(packageJson?.scripts?.["start:test"] ?? "");
  const anchorFiles = implementation.filter((file) => file.endsWith(".rs") && file.includes(`${path.sep}programs${path.sep}`));
  const combined = (await Promise.all(implementation.slice(0, 400).map((file) => fs.readFile(file, "utf8").catch(() => "")))).join("\n");
  const anchorSignals = ["#[program]", "#[account]", "declare_id!", "emit!", "checked_"].filter((signal) => combined.includes(signal));
  const layers = ["domain", "api", "web"].filter((name) => files.some((file) => file.toLowerCase().includes(name)));

  return [
    result(
      "delivery_structure",
      3,
      implementation.length >= 12 && layers.length === 3 && startCommand.length > 0 && !startCommand.includes("尚未实现"),
      `实现源文件 ${implementation.length} 个；层次 ${layers.join("/") || "无"}；start:test ${startCommand ? "存在" : "缺失"}`,
    ),
    result(
      "anchor_contract",
      3,
      anchorFiles.length >= 2 && anchorSignals.length >= 4 && files.some((file) => path.basename(file) === "Anchor.toml"),
      `Anchor Rust 文件 ${anchorFiles.length} 个；安全/合约信号 ${anchorSignals.length}/5`,
    ),
    result(
      "own_tests_and_docs",
      2,
      tests.length >= 4 && files.some((file) => /threat|威胁/i.test(path.basename(file))),
      `自有测试文件 ${tests.length} 个；威胁模型 ${files.some((file) => /threat|威胁/i.test(path.basename(file))) ? "存在" : "缺失"}`,
    ),
  ];
}

function result(id, points, passed, detail) {
  return { id, section: "工程交付", points, passed, earned: passed ? points : 0, detail };
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return undefined; }
}

async function walk(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  const output = [];
  for (const entry of entries) {
    if (["node_modules", ".git", "dist", "target", "coverage", ".anchor", ".allycode-eval"].includes(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walk(full));
    else output.push(full);
  }
  return output;
}
