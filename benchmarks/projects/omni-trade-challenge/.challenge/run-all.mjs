import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { runStaticChecks } from "./static-check.mjs";
import { runAcceptance } from "./acceptance.mjs";

const root = process.cwd();
const evaluatorDirectory = path.dirname(fileURLToPath(import.meta.url));
const environment = {
  ...process.env,
  PORT: "4300",
  WEB_PORT: "4173",
  EXTERNAL_API_BASE: "http://127.0.0.1:4400",
  SUPPLIER_API_KEY: "challenge-supplier-key",
  WEBHOOK_SECRET: "challenge-webhook-secret",
  ALLYCODE_CHALLENGE: "1",
  NODE_ENV: "test",
};
const children = [];
const output = [];

try {
  const results = await runStaticChecks();
  const mocks = start(process.execPath, [path.join(evaluatorDirectory, "mock-services.mjs")], "mocks");
  children.push(mocks);
  await waitFor("http://127.0.0.1:4400/__control/metrics", 8_000);

  const npmCommand = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm";
  const npmArgs = process.platform === "win32" ? ["/d", "/s", "/c", "npm.cmd run start:test"] : ["run", "start:test"];
  const application = start(npmCommand, npmArgs, "application");
  children.push(application);
  await Promise.all([
    waitFor("http://127.0.0.1:4300/health", 25_000, application),
    waitFor("http://127.0.0.1:4173/", 25_000, application),
  ]);
  results.push(...await runAcceptance());
  await writeReport(results, output);
  print(results);
  if (results.some((item) => !item.passed)) process.exitCode = 1;
} catch (error) {
  const results = await runStaticChecks();
  results.push({ id: "startup", section: "基础运行", points: 93, earned: 0, passed: false, detail: error instanceof Error ? error.message : String(error) });
  await writeReport(results, output);
  print(results);
  process.exitCode = 1;
} finally {
  for (const child of children.reverse()) terminateTree(child);
}

function start(command, args, label) {
  const child = spawn(command, args, { cwd: root, env: environment, windowsHide: true });
  const collect = (stream, kind) => stream.on("data", (chunk) => {
    const text = chunk.toString();
    output.push(`[${label}:${kind}] ${text}`);
    if (output.length > 300) output.shift();
  });
  collect(child.stdout, "out");
  collect(child.stderr, "err");
  return child;
}

async function waitFor(url, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) throw new Error(`应用启动进程提前退出，退出码 ${child.exitCode}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(750) });
      if (response.status < 500) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`服务未在 ${timeoutMs}ms 内就绪：${url}`);
}

function terminateTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
  else child.kill("SIGTERM");
}

async function writeReport(results, logs) {
  const directory = path.join(root, ".allycode-eval");
  await fs.mkdir(directory, { recursive: true });
  const report = {
    challenge: "omni-trade-industrial-agent-challenge",
    generatedAt: new Date().toISOString(),
    score: results.reduce((sum, item) => sum + item.earned, 0),
    total: results.reduce((sum, item) => sum + item.points, 0),
    results,
    recentProcessOutput: logs.slice(-100).join("").slice(-20_000),
    boundary: "This score covers the local contract only; it is not an international Agent benchmark.",
  };
  await fs.writeFile(path.join(directory, "latest.json"), JSON.stringify(report, null, 2), "utf8");
}

function print(results) {
  console.log("\nOmniTrade 挑战结果\n");
  for (const item of results) console.log(`${item.passed ? "PASS" : "FAIL"} [${item.section}] ${item.id} ${item.earned}/${item.points} - ${item.detail}`);
  const earned = results.reduce((sum, item) => sum + item.earned, 0);
  const total = results.reduce((sum, item) => sum + item.points, 0);
  console.log(`\n总分：${earned}/${total}`);
  console.log("报告：.allycode-eval/latest.json");
}
