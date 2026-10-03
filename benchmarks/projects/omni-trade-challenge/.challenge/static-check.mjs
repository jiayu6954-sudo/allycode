import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();

export async function runStaticChecks() {
  const files = await walk(root);
  const implementation = files.filter((file) => !file.includes(`${path.sep}.challenge${path.sep}`) && /\.(?:ts|tsx|js|jsx|mjs|css|html)$/i.test(file));
  const tests = implementation.filter((file) => /(?:test|spec)/i.test(path.basename(file)) || file.includes(`${path.sep}test${path.sep}`) || file.includes(`${path.sep}tests${path.sep}`));
  const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  const startCommand = String(packageJson.scripts?.["start:test"] ?? "");
  const combined = (await Promise.all(implementation.slice(0, 250).map((file) => fs.readFile(file, "utf8").catch(() => "")))).join("\n");
  const pages = ["总览", "商品", "订单", "客服", "自动化"].filter((label) => combined.includes(label));

  return [
    result("implementation_structure", 3, implementation.length >= 8 && !startCommand.includes("not-implemented"), `实现源文件 ${implementation.length} 个；start:test ${!startCommand ? "缺失" : startCommand.includes("not-implemented") ? "仍是占位命令" : "已实现"}`),
    result("own_tests", 2, tests.length >= 3, `发现自有测试文件 ${tests.length} 个（至少 3 个）`),
    result("frontend_information_architecture", 2, pages.length === 5, `中文页面标识 ${pages.length}/5：${pages.join("、") || "无"}`),
  ];
}

function result(id, points, passed, detail) {
  return { id, section: "工程结构", points, passed, earned: passed ? points : 0, detail };
}

async function walk(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const output = [];
  for (const entry of entries) {
    if (["node_modules", ".git", "dist", "coverage", ".challenge-results"].includes(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walk(full));
    else output.push(full);
  }
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/(.:)/, "$1"))) {
  const results = await runStaticChecks();
  for (const item of results) console.log(`${item.passed ? "PASS" : "FAIL"} ${item.id} (${item.earned}/${item.points}) ${item.detail}`);
  if (results.some((item) => !item.passed)) process.exitCode = 1;
}
