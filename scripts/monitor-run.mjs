#!/usr/bin/env node
/**
 * Independent execution monitor for an AllyCode task.
 *
 * Reads the same persisted event timeline the desktop monitor uses, but judges
 * behaviour rather than narrating it: which tools were actually used, whether a
 * server was started in the shell tool (the failure that stranded every
 * frontend task), whether real browser evidence exists, and where the run
 * looped, timed out, or stalled on a permission prompt.
 *
 * It never trusts assistant prose — only tool inputs, tool results and the
 * project's own artifacts.
 *
 *   node scripts/monitor-run.mjs                     # latest task
 *   node scripts/monitor-run.mjs --project <path>    # latest task for a project
 *   node scripts/monitor-run.mjs --task <id>
 *   node scripts/monitor-run.mjs --watch 20          # re-report every 20s
 *   node scripts/monitor-run.mjs --tail 40           # last 40 tool calls
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

const args = parseArgs(process.argv.slice(2));
const dataDir = process.env.ALLYCODE_DATA_DIR?.trim()
  ? path.resolve(process.env.ALLYCODE_DATA_DIR.trim())
  : path.join(os.homedir(), ".allycode");
const dbPath = path.join(dataDir, "agent-state.sqlite");

if (!fs.existsSync(dbPath)) {
  console.error(`No AllyCode database at ${dbPath}. Run a task first.`);
  process.exit(1);
}

/** A shell command that starts something which never exits on its own. */
const LONG_RUNNING_SHELL = /(?:^|[;&|]\s*)(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:dev|start|serve|preview|start:test|start:api|start:web)\b|\bvite(?!\s+build)\b|\bnext\s+(?:dev|start)\b|\bnodemon\b|--watch\b|\bhttp-server\b|\bserve\s+-/i;
const IDLE_STALL_MS = 90_000;

await main();

async function main() {
  if (args.watch) {
    for (;;) {
      console.clear();
      report();
      await new Promise((resolve) => setTimeout(resolve, args.watch * 1000));
    }
  }
  report();
}

function report() {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const task = selectTask(db);
    if (!task) {
      console.log("No matching task found.");
      return;
    }
    const events = db
      .prepare("SELECT id, run_id, event_type, payload_json, created_at FROM task_events WHERE task_id = ? ORDER BY id")
      .all(task.id)
      .map((row) => ({
        id: row.id,
        runId: row.run_id,
        eventType: row.event_type,
        payload: safeParse(row.payload_json),
        createdAt: row.created_at,
      }));

    header(task, events);
    const runs = collectToolRuns(events);
    tokenSummary(events);
    toolSummary(runs);
    behaviourChecks(runs, events);
    timeline(runs);
    gateResult(events);
    challengeScore(task);
  } finally {
    db.close();
  }
}

function tokenSummary(events) {
  const usage = events
    .filter((event) => event.eventType === "agent_usage")
    .map((event) => ({
      input: numeric(event.payload?.inputTokens),
      output: numeric(event.payload?.outputTokens),
      cacheRead: numeric(event.payload?.cacheReadTokens),
      cacheWrite: numeric(event.payload?.cacheWriteTokens),
    }));
  const streams = events
    .filter((event) => event.eventType === "agent_stream_summary")
    .map((event) => ({
      saved: numeric(event.payload?.contextTokensSaved),
      trims: numeric(event.payload?.contextTrims),
    }));

  console.log("\nTOKEN / CONTEXT");
  if (usage.length === 0) {
    console.log("  no Provider usage events recorded yet");
    return;
  }

  const totals = usage.reduce((sum, item) => ({
    input: sum.input + item.input,
    output: sum.output + item.output,
    cacheRead: sum.cacheRead + item.cacheRead,
    cacheWrite: sum.cacheWrite + item.cacheWrite,
  }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const promptByTurn = usage.map((item) => item.input + item.cacheRead);
  const first = promptByTurn[0] ?? 0;
  const latest = promptByTurn.at(-1) ?? 0;
  const maximum = Math.max(...promptByTurn);
  const cacheDenominator = totals.input + totals.cacheRead;
  const cacheRate = cacheDenominator > 0 ? totals.cacheRead / cacheDenominator : null;
  const saved = streams.reduce((sum, item) => sum + item.saved, 0);
  const trims = streams.reduce((sum, item) => sum + item.trims, 0);

  console.log(`  model turns     ${usage.length}`);
  console.log(`  uncached input  ${totals.input.toLocaleString()}   output ${totals.output.toLocaleString()}`);
  console.log(`  cache read      ${totals.cacheRead.toLocaleString()}   write ${totals.cacheWrite.toLocaleString()}   hit rate ${cacheRate === null ? "not reported" : `${(cacheRate * 100).toFixed(1)}%`}`);
  console.log(`  prompt / turn   first ${first.toLocaleString()}   latest ${latest.toLocaleString()}   max ${maximum.toLocaleString()}`);
  console.log(`  context trims   ${trims.toLocaleString()}   tokens kept off wire ${saved.toLocaleString()}${streams.length === 0 ? " (reported when a run closes/checkpoints)" : ""}`);
  if (usage.length >= 4 && latest > Math.max(8_000, first * 3)) {
    console.log(`  [WARN] context growth: ${first.toLocaleString()} → ${latest.toLocaleString()} prompt tokens per turn`);
  }
}

function numeric(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function selectTask(db) {
  if (args.task) {
    return db.prepare("SELECT * FROM tasks WHERE id = ?").get(args.task);
  }
  if (args.project) {
    const normalized = path.resolve(args.project).toLowerCase().replace(/\\/g, "/");
    const row = db
      .prepare("SELECT project_id FROM project_paths WHERE REPLACE(LOWER(normalized_path),'\\','/') = ?")
      .get(normalized);
    if (!row) return null;
    return db
      .prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1")
      .get(row.project_id);
  }
  return db.prepare("SELECT * FROM tasks ORDER BY updated_at DESC LIMIT 1").get();
}

function header(task, events) {
  const runIds = [...new Set(events.map((event) => event.runId).filter(Boolean))];
  const last = events.at(-1);
  const idleMs = last ? Date.now() - Date.parse(last.createdAt) : 0;
  line("=");
  console.log(`TASK   ${task.title}`);
  console.log(`id     ${task.id}`);
  console.log(`status ${task.status.toUpperCase()}   runs: ${runIds.length}   events: ${events.length}`);
  console.log(`opened ${task.created_at}    updated ${task.updated_at}`);
  if (task.last_error) console.log(`error  ${String(task.last_error).slice(0, 300)}`);
  if (["running", "waiting_permission"].includes(task.status)) {
    console.log(`idle   ${Math.round(idleMs / 1000)}s since the last event${idleMs > IDLE_STALL_MS ? "   ← STALLED" : ""}`);
  }
  line("=");
}

function collectToolRuns(events) {
  const byId = new Map();
  const order = [];
  for (const event of events) {
    const toolId = event.payload?.toolId;
    if (!toolId) continue;
    if (event.eventType === "agent_tool_start") {
      const run = {
        toolId,
        name: event.payload.toolName ?? "unknown",
        input: event.payload.input ?? {},
        startedAt: event.createdAt,
        finishedAt: null,
        succeeded: null,
        result: "",
      };
      byId.set(toolId, run);
      order.push(run);
    } else if (event.eventType === "agent_tool_result") {
      const run = byId.get(toolId);
      if (!run) continue;
      run.succeeded = event.payload.isError !== true;
      run.result = String(event.payload.content ?? "");
      run.finishedAt = event.createdAt;
    }
  }
  return order;
}

function toolSummary(runs) {
  if (runs.length === 0) {
    console.log("\nNo tool calls recorded yet.\n");
    return;
  }
  const stats = new Map();
  for (const run of runs) {
    const entry = stats.get(run.name) ?? { ok: 0, err: 0, pending: 0 };
    if (run.succeeded === true) entry.ok++;
    else if (run.succeeded === false) entry.err++;
    else entry.pending++;
    stats.set(run.name, entry);
  }
  console.log(`\nTOOL USE  (${runs.length} calls)`);
  for (const [name, entry] of [...stats].sort((a, b) => (b[1].ok + b[1].err) - (a[1].ok + a[1].err))) {
    const bits = [`ok ${entry.ok}`, entry.err > 0 ? `error ${entry.err}` : "", entry.pending > 0 ? `running ${entry.pending}` : ""]
      .filter(Boolean).join("  ");
    console.log(`  ${name.padEnd(16)} ${bits}`);
  }
}

function behaviourChecks(runs, events) {
  const findings = [];
  const bash = runs.filter((run) => run.name === "bash");
  const commands = bash.map((run) => String(run.input?.command ?? ""));

  // The regression this monitor exists for.
  const shellServers = bash.filter((run) => LONG_RUNNING_SHELL.test(String(run.input?.command ?? "")));
  if (shellServers.length > 0) {
    findings.push({
      level: "CRITICAL",
      text: `${shellServers.length} long-running command(s) started with the SHELL tool instead of service_start. ` +
        "The tool kills its whole process tree on timeout, so the server cannot survive to be verified.",
      detail: shellServers.slice(0, 3).map((run) => `  → ${String(run.input.command).slice(0, 120)}`),
    });
  }

  const timeouts = runs.filter((run) => /timed out after \d+ms/i.test(run.result));
  if (timeouts.length > 0) {
    findings.push({
      level: "WARN",
      text: `${timeouts.length} tool call(s) hit their timeout and had the process tree terminated.`,
      detail: timeouts.slice(0, 3).map((run) => `  → ${String(run.input?.command ?? run.name).slice(0, 120)}`),
    });
  }

  // Identical command repeated — the shape of a stuck loop.
  const repeats = new Map();
  for (const command of commands) {
    const key = command.trim();
    if (key) repeats.set(key, (repeats.get(key) ?? 0) + 1);
  }
  const looping = [...repeats].filter(([, count]) => count >= 3).sort((a, b) => b[1] - a[1]);
  if (looping.length > 0) {
    findings.push({
      level: "WARN",
      text: `${looping.length} command(s) repeated 3+ times identically — likely a retry loop.`,
      detail: looping.slice(0, 3).map(([command, count]) => `  → ×${count}  ${command.slice(0, 110)}`),
    });
  }

  let streak = 0;
  let worstStreak = 0;
  for (const run of runs) {
    if (run.succeeded === false) worstStreak = Math.max(worstStreak, ++streak);
    else if (run.succeeded === true) streak = 0;
  }
  if (worstStreak >= 3) {
    findings.push({ level: "WARN", text: `Longest consecutive tool-failure streak: ${worstStreak}.` });
  }

  const services = runs.filter((run) => run.name === "service_start");
  const healthy = services.filter((run) => run.succeeded === true);
  const browser = runs.filter((run) => run.name === "browser_verify");
  const browserPassed = browser.filter((run) => run.succeeded === true);

  console.log("\nBEHAVIOUR");
  console.log(`  service_start   ${services.length} call(s), ${healthy.length} reached a verified ready state`);
  console.log(`  browser_verify  ${browser.length} call(s), ${browserPassed.length} passed`);
  for (const run of browser) {
    const url = run.input?.url ?? "";
    const paths = Array.isArray(run.input?.paths) ? ` +${run.input.paths.length} routes` : "";
    const verdict = run.succeeded === true ? "PASS" : run.succeeded === false ? "FAIL" : "running";
    console.log(`     ${verdict.padEnd(8)} ${url}${paths}`);
    if (run.succeeded === false) {
      for (const detail of extractFailureLines(run.result)) console.log(`              ${detail}`);
    }
  }

  const permissionWaits = events.filter((event) => event.eventType === "permission_requested").length;
  const permissionResolved = events.filter((event) => event.eventType === "permission_resolved").length;
  if (permissionWaits > permissionResolved) {
    findings.push({
      level: "BLOCKED",
      text: `A permission prompt is unanswered (${permissionWaits} requested, ${permissionResolved} resolved). The agent is waiting on you.`,
    });
  }

  const errors = events.filter((event) => event.eventType === "agent_error");
  if (errors.length > 0) {
    findings.push({
      level: "WARN",
      text: `${errors.length} agent-level error event(s).`,
      detail: errors.slice(-2).map((event) => `  → ${String(event.payload?.message ?? JSON.stringify(event.payload)).slice(0, 160)}`),
    });
  }

  const boundaries = events.filter((event) => event.eventType === "run_budget_boundary");
  if (boundaries.length > 0) {
    console.log(`  run budget      hit ${boundaries.length} time(s) — the task was checkpointed, not failed`);
  }

  console.log("\nFINDINGS");
  if (findings.length === 0) {
    console.log("  none — no shell-started servers, no retry loops, no unanswered prompts.");
  }
  for (const finding of findings) {
    console.log(`  [${finding.level}] ${finding.text}`);
    for (const detail of finding.detail ?? []) console.log(`  ${detail}`);
  }
}

function extractFailureLines(result) {
  return String(result)
    .split("\n")
    .filter((row) => /^- (?:failure|MISSING|http status)|uncaught JavaScript/.test(row.trim()))
    .slice(0, 4)
    .map((row) => row.trim());
}

function timeline(runs) {
  const tail = args.tail ?? 15;
  if (runs.length === 0) return;
  console.log(`\nLAST ${Math.min(tail, runs.length)} TOOL CALLS`);
  for (const run of runs.slice(-tail)) {
    const mark = run.succeeded === true ? "ok  " : run.succeeded === false ? "FAIL" : "... ";
    const elapsed = run.finishedAt
      ? `${Math.max(0, Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000))}s`
      : "";
    console.log(`  ${run.startedAt.slice(11, 19)} ${mark} ${run.name.padEnd(15)} ${elapsed.padStart(5)}  ${describe(run)}`);
  }
}

function describe(run) {
  const input = run.input ?? {};
  const first = input.command ?? input.url ?? input.path ?? input.pattern ?? input.query ?? input.name ?? "";
  return String(first).replace(/\s+/g, " ").slice(0, 96);
}

function gateResult(events) {
  const gate = events.filter((event) => event.eventType === "completion_verification").at(-1);
  if (!gate) return;
  console.log("\nCOMPLETION GATE");
  console.log(`  status: ${String(gate.payload?.status).toUpperCase()}   ${gate.payload?.summary ?? ""}`);
  for (const check of gate.payload?.checks ?? []) {
    console.log(`  [${String(check.status).padEnd(14)}] ${check.label} — ${check.evidence}`);
  }
}

function challengeScore(task) {
  const roots = new Set();
  if (args.project) roots.add(path.resolve(args.project));
  roots.add(path.resolve("benchmarks/projects/binary-market-protocol-challenge"));
  for (const root of roots) {
    const file = path.join(root, ".allycode-eval", "latest.json");
    if (!fs.existsSync(file)) continue;
    const report = safeParse(fs.readFileSync(file, "utf8"));
    if (!report) continue;
    console.log(`\nINDEPENDENT CHALLENGE SCORE  ${report.score}/${report.total}   (${report.generatedAt})`);
    for (const item of report.results ?? []) {
      console.log(`  ${item.passed ? "PASS" : "FAIL"} ${String(item.earned).padStart(3)}/${String(item.points).padEnd(3)} [${item.section}] ${item.id} — ${item.detail}`);
    }
    break;
  }
  void task;
}

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--project") out.project = argv[++index];
    else if (flag === "--task") out.task = argv[++index];
    else if (flag === "--watch") out.watch = Number(argv[++index] ?? 20) || 20;
    else if (flag === "--tail") out.tail = Number(argv[++index] ?? 15) || 15;
  }
  return out;
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function line(char) {
  console.log(char.repeat(72));
}
