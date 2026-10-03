import fs from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { runStaticChecks } from "./static-check.mjs";
import { runAcceptance } from "./acceptance.mjs";

const root = process.cwd();
const resultDirectory = process.env.ALLYCODE_EVAL_RESULT_DIR || path.join(root, ".allycode-eval");
const evaluationRunId = process.env.ALLYCODE_EVAL_RUN_ID;
const environment = {
  ...process.env,
  API_PORT: "4310",
  WEB_PORT: "4174",
  ORACLE_SECRET: "challenge-oracle-secret",
  NETWORK_MODE: "local_only",
  ALLYCODE_CHALLENGE: "1",
  NODE_ENV: "test",
};
const children = [];
delete environment.ALLYCODE_EVAL_RESULT_DIR;
delete environment.ALLYCODE_EVAL_RUN_ID;
const output = [];

try {
  const results = await runStaticChecks();
  const npmCommand = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm";
  const npmArgs = process.platform === "win32" ? ["/d", "/s", "/c", "npm.cmd run start:test"] : ["run", "start:test"];
  const application = start(npmCommand, npmArgs, "application");
  children.push(application);
  await Promise.all([
    waitFor("http://127.0.0.1:4310/health", 35_000, application),
    waitFor("http://127.0.0.1:4174/", 35_000, application),
  ]);
  results.push(...await runAcceptance());
  await writeReport(results);
  print(results);
  if (results.some((item) => !item.passed)) process.exitCode = 1;
} catch (error) {
  const results = await runStaticChecks();
  results.push({ id: "startup", section: "基础运行", points: 92, earned: 0, passed: false, detail: error instanceof Error ? error.message : String(error) });
  await writeReport(results);
  print(results);
  process.exitCode = 1;
} finally {
  for (const child of children.reverse()) terminateTree(child);
}

function start(command, args, label) {
  const child = spawn(command, args, { cwd: root, env: environment, windowsHide: true });
  const collect = (stream, kind) => stream.on("data", (chunk) => {
    output.push(`[${label}:${kind}] ${chunk.toString()}`);
    if (output.length > 300) output.shift();
  });
  collect(child.stdout, "out");
  collect(child.stderr, "err");
  return child;
}

async function waitFor(url, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`应用启动进程提前退出，退出码 ${child.exitCode}`);
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

async function writeReport(results) {
  const directory = resultDirectory;
  await fs.mkdir(directory, { recursive: true });
  const report = {
    runId: evaluationRunId,
    challenge: "binary-market-protocol-agent-challenge",
    generatedAt: new Date().toISOString(),
    score: results.reduce((sum, item) => sum + item.earned, 0),
    total: results.reduce((sum, item) => sum + item.points, 0),
    results,
    recentProcessOutput: output.slice(-100).join("").slice(-20_000),
    environment: detectEnvironment(),
    boundary: "仅覆盖本地公开合同；没有主网、真钱或真实客户验收，不等同于国际 Agent 总榜成绩。",
  };
  await fs.writeFile(path.join(directory, "latest.json"), JSON.stringify(report, null, 2), "utf8");
}

function detectEnvironment() {
  const tools = ["cargo", "rustc", "solana", "anchor", "docker"].map((name) => {
    const probe = spawnSync(process.platform === "win32" ? "where.exe" : "which", [name], { windowsHide: true, encoding: "utf8" });
    return { name, available: probe.status === 0 };
  });
  return { node: process.version, platform: process.platform, arch: process.arch, tools };
}

function print(results) {
  console.log("\nBinary Market Protocol 挑战结果\n");
  for (const item of results) console.log(`${item.passed ? "PASS" : "FAIL"} [${item.section}] ${item.id} ${item.earned}/${item.points} - ${item.detail}`);
  const earned = results.reduce((sum, item) => sum + item.earned, 0);
  const total = results.reduce((sum, item) => sum + item.points, 0);
  console.log(`\n总分：${earned}/${total}`);
  console.log("报告：.allycode-eval/latest.json");
}
