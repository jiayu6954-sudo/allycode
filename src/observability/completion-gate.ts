import { workspaceRevision } from "../storage/workspace-snapshots.js";
import fs from "node:fs/promises";
import path from "node:path";
import type { TaskEventRecord } from "../storage/agent-database.js";
import { resolveWorkspacePath } from "../tools/path-guard.js";
import { hashDocument } from "../tools/sources-to-excel.js";

export type CompletionCheckStatus = "passed" | "failed" | "not_applicable";

export interface CompletionCheck {
  id: string;
  label: string;
  status: CompletionCheckStatus;
  evidence: string;
}

export interface CompletionGateReport {
  schemaVersion: 1;
  status: CompletionCheckStatus;
  generatedAt: string;
  checks: CompletionCheck[];
  summary: string;
}

interface ToolRun {
  name: string;
  input: Record<string, unknown>;
  succeeded: boolean;
  result: string;
  startedAt: number;
  endedAt: number;
  runId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Deterministic completion evidence gate. It never trusts the assistant's prose:
 * only persisted tool results and project-owned verification contracts count.
 */
export async function evaluateCompletionEvidence(
  cwd: string,
  events: TaskEventRecord[],
  options: { allowDocumentOnly?: boolean } = {},
): Promise<CompletionGateReport> {
  const engineering = await evaluateEngineeringEvidence(cwd, events, options);
  const runs = collectToolRuns(events);
  const activeRun = runs.at(-1)?.runId;
  const builds = runs.filter(run => run.runId === activeRun && run.name === "sources_to_excel" && run.input.action === "build");
  const documents = runs.filter(run => run.runId === activeRun && (run.name === "document_verify" || (run.name === "document_format" && ["build","pdf_to_word","title_spacing"].includes(String(run.input.action)))));
  const conversions = runs.filter(run => run.runId === activeRun && run.name === "document_format" && run.input.action === "word_to_pdf");
  if (!builds.length && !documents.length && !conversions.length) return engineering;
  const latest = new Map<string, ToolRun>();
  for (const run of builds) latest.set(String(record(run.input.request).output ?? "unknown"), run);
  const checks: CompletionCheck[] = [...engineering.checks];
  const latestConversions=new Map<string,ToolRun>();
  for(const run of conversions)latestConversions.set(String(record(run.metadata?.convertedArtifact).output??record(run.input.request).output??"unknown"),run);
  for(const [output,run] of latestConversions){
    const valid=await validConversionEvidence(cwd,run);
    checks.push({id:"pdf_artifact",label:"PDF 转换产物",status:valid?"passed":"failed",evidence:valid?`${output}：PDF 重开页数有效、来源与输出哈希一致；排版与字体替代尚需按页复核。`:`${output}：转换未成功或文件已变化，请重新核对。`});
  }
  const latestDocuments = new Map<string, ToolRun>();
  const unlocated: ToolRun[] = [];
  let declaredDeliveries: string[] | undefined;
  for (const run of documents) {
    const artifact = record(run.metadata?.documentArtifact);
    const output = artifact.output ?? run.input.path ?? record(run.input.request).output;
    if (typeof output === "string") latestDocuments.set(documentKey(cwd, output), run);
    else unlocated.push(run);
    if (run.succeeded && Array.isArray(artifact.deliveryFiles)) declaredDeliveries = artifact.deliveryFiles.map(file => documentKey(cwd, String(file)));
  }
  const selected = declaredDeliveries ?? [...latestDocuments.keys()];
  if (unlocated.length) checks.push({id:"document_attempts",label:"文档生成尝试",status:selected.length ? "not_applicable" : "failed",evidence:`${unlocated.length} 次调用未返回可定位产物；保留为执行诊断，不虚构 unknown 交付文件。${selected.length ? "交付结论由下列文件的实际校验决定。" : "仍需成功生成并校验所需报告。"}`});
  if (declaredDeliveries) {
    const excluded = [...latestDocuments.keys()].filter(file => !selected.includes(file));
    if (excluded.length) checks.push({id:"document_scope",label:"非交付文档",status:"not_applicable",evidence:`执行者声明以下文件为非交付范围：${excluded.join("、")}。声明不等于验收通过，历史失败仍保留；请核对正式清单是否覆盖用户需求。`});
  }
  for (const output of new Set(selected)) {
    const run = latestDocuments.get(output);
    let evidence = `${output}：DOCX 结构与指定文本断言通过，文件与来源哈希一致；尚不证明排版、全量数据覆盖或业务数值正确。`;
    const valid = !!run && await validDocumentEvidence(cwd, run);
    if (!valid) evidence = `${output}：缺少有效 Word 校验证据，或报告/来源已经改变。请修复后调用 document_verify。`;
    checks.push({ id: "word_artifact", label: "Word 产物校验", status: valid ? "passed" : "failed", evidence });
  }
  for (const [output, run] of latest) {
    try {
      const artifact = record(run.metadata?.artifact);
      if (!run.succeeded || !artifact.output || !artifact.audit) throw new Error("最近一次生成没有成功的产物校验证据。");
      const file = resolveWorkspacePath(cwd, String(artifact.output));
      const auditFile = resolveWorkspacePath(cwd, String(artifact.audit));
      if (await hashDocument(file) !== artifact.sha256 || await hashDocument(auditFile) !== artifact.auditSha256) throw new Error("生成文件或审计文件已改变，需要重新生成/核对。");
      const audit = JSON.parse(await fs.readFile(auditFile, "utf8")) as { manifest: { files: Array<{path:string;sha256?:string}> }; result: { unresolved_files: string[]; review_rows:number; formulas?:{count:number;status:string} } };
      const formula = audit.result.formulas;
      if (formula?.count && formula.status !== "recalculated_and_verified") throw new Error("Excel 公式尚未完成本地重算和预期值校验，不能按已计算完成交付。");
      for (const source of audit.manifest.files) if (source.sha256 && await hashDocument(resolveWorkspacePath(cwd, source.path)) !== source.sha256) throw new Error("源资料已改变，需要重新扫描与核对。");
      checks.push({ id: "spreadsheet_artifact", label: "Excel 产物校验", status: "passed", evidence: `${output}：工具写后重开校验通过，产物/审计/源资料哈希一致。${formula?.count ? `${formula.count} 个公式已重算并与预期值核对。` : ""}未解决文件 ${audit.result.unresolved_files.length}，待核实记录 ${audit.result.review_rows}；不证明 OCR 或业务语义全部正确。` });
    } catch (error) { checks.push({ id: "spreadsheet_artifact", label: "Excel 产物校验", status: "failed", evidence: error instanceof Error ? error.message : "产物核对失败" }); }
  }
  return report(checks.some(check=>check.status==="failed") ? "failed" : "passed", checks);
}

function documentKey(cwd: string, file: string): string {
  const resolved = path.resolve(cwd, file);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function evaluateEngineeringEvidence(
  cwd: string,
  events: TaskEventRecord[],
  options: { allowDocumentOnly?: boolean } = {},
): Promise<CompletionGateReport> {
  const allRuns = collectToolRuns(events);
  const hasRevision = allRuns.some((run) => run.metadata?.["afterRevision"]);
  const currentRevision = hasRevision ? await workspaceRevision(cwd).catch(() => "unavailable") : undefined;
  for (const run of allRuns) {
    if (run.metadata?.["afterRevision"] && (currentRevision === "unavailable" || run.metadata["afterRevision"] !== currentRevision || run.metadata["beforeRevision"] !== run.metadata["afterRevision"] || path.resolve(String(run.metadata["cwd"])) !== path.resolve(cwd))) run.succeeded = false;
  }
  const packageJson = await readPackageJson(cwd);
  const scripts = record(packageJson?.["scripts"]);
  const dependencies = { ...record(packageJson?.["dependencies"]), ...record(packageJson?.["devDependencies"]) };
  const customCommands = new Set<string>();
  for (const run of allRuns.filter(run => run.name === "bash")) {
    const command = stringValue(run.input, "command") ?? "";
    if (await isProjectPowerShellTest(cwd, command)) customCommands.add(command);
  }
  const mutations = allRuns.filter((run) => {
    if (run.name === "desktop_control") return !["list_windows", "inspect", "screenshot"].includes(String(run.input.action));
    if (["file_write", "file_edit", "codex:file_change"].includes(run.name)) return true;
    if (run.name.startsWith("mcp") || run.name.includes("__") || run.name.includes("file_change")) return true;
    if (run.name !== "bash") return false;
    if (run.metadata?.["beforeRevision"] && run.metadata["beforeRevision"] !== run.metadata["afterRevision"]) return true;
    const command = stringValue(run.input, "command") ?? "";
    return !customCommands.has(command) && !isVerification(command, scripts) && !isReadOnlyCommand(command);
  });
  if (mutations.length === 0) return report("not_applicable", [{ id: "code_mutation", label: "改动验收", status: "not_applicable", evidence: "没有检测到需要工程验收的修改或未知副作用。" }]);
  if (options.allowDocumentOnly && mutations.every(run=>["file_write","file_edit"].includes(run.name) && run.succeeded && /\.md$/i.test(stringValue(run.input,"path")??""))) {
    return report("not_applicable",[{id:"design_review",label:"方案文档阶段",status:"not_applicable",evidence:"本阶段仅有 Markdown 文档修改，等待用户选择方案；没有据此证明实现或业务验收通过。"}]);
  }
  const lastMutation = Math.max(...mutations.map((run) => run.endedAt < 0 ? run.startedAt : run.endedAt));
  const activeRun = allRuns.at(-1)?.runId;
  const runs = allRuns.filter((run) => run.startedAt > lastMutation && (!activeRun || run.runId === activeRun));
  const successfulCommands = runs.filter((run) => run.name === "bash" && run.succeeded)
    .map((run) => stringValue(run.input, "command") ?? "").filter(Boolean);
  const executedScripts = new Set<string>();
  for (const run of runs.filter((item) => item.name === "bash")) {
    for (const name of expandExecutedScripts([stringValue(run.input, "command") ?? ""], scripts)) {
      if (run.succeeded) executedScripts.add(name); else executedScripts.delete(name);
    }
  }
  if (!packageJson) {
    // A Word verifier proves only its declared artifact assertions. It can satisfy
    // the generic (non-package) contract, just as a project test can. Package
    // projects still require their declared test/build checks below.
    const documentRuns = runs.filter(run => run.name === "document_verify" || (run.name === "document_format" && ["build","pdf_to_word","title_spacing"].includes(String(run.input.action))));
    if (documentRuns.length) {
      const valid = await validDocumentEvidence(cwd, documentRuns.at(-1)!);
      return report(valid ? "passed" : "failed", [{ id: "document_verification", label: "文档验收证据", status: valid ? "passed" : "failed", evidence: valid ? "最后修改之后已独立校验 Word 产物；此项不证明辅助脚本通用质量、数据分析准确性或视觉排版。" : "Word 校验失败、来源已改变或工作区版本不匹配，请先修复对应问题。" }]);
    }
    const attempts = runs.filter((run) => run.name === "bash" && (customCommands.has(stringValue(run.input,"command") ?? "") || isGenericVerificationCommand(stringValue(run.input, "command") ?? "")));
    const verified = attempts.length > 0 && attempts.every((run) => run.succeeded);
    const backgroundTest = allRuns.some(run => run.name === "service_start" && /test|e2e|verify/i.test(stringValue(run.input,"command") ?? ""));
    const reason = attempts.some(run => !run.succeeded)
      ? "验证命令失败或工作区版本不匹配，请修复后重新验证。"
      : "最后修改或未知 shell 副作用之后，缺少同一执行轮次内成功退出的验证命令。";
    return report(verified ? "passed" : "failed", [{ id: "generic_verification", label: "修改后的验证证据", status: verified ? "passed" : "failed", evidence: verified ? "最后修改之后的独立验证命令成功退出；仅覆盖该命令实际断言的范围。" : reason + (backgroundTest ? "后台服务启动/读取日志不能充当测试完成证明。" : "") + "若交付 Word 报告：先生成 .docx，再用 document_verify 校验正文与关键数字，另行核算数据及复核排版。若交付软件：单独运行项目实际测试（如 tests 下的 PowerShell 脚本或 pytest），设置足够 timeout；不要为报告虚构工程测试，也不要拼接清理和 Git 检查掩盖失败。" }]);
  }
  const checks: CompletionCheck[] = [];
  const standardScripts = ["test", "typecheck", "lint", "build"].filter((name) =>
    typeof scripts[name] === "string"
  );

  if (standardScripts.length === 0) {
    checks.push({
      id: "verification_contract",
      label: "项目验证契约",
      status: "failed",
      evidence: "代码项目未声明 test、typecheck、lint 或 build 脚本，无法证明可交付。",
    });
  } else {
    for (const script of standardScripts) {
      const passed = executedScripts.has(script);
      checks.push({
        id: `script_${script}`,
        label: `运行 ${script}`,
        status: passed ? "passed" : "failed",
        evidence: passed
          ? `持久化工具结果证明 ${script} 成功退出。`
          : `package.json 声明了 ${script}，但本轮没有成功执行证据。`,
      });
    }
  }

  const webFrontend = await hasWebFrontend(cwd, dependencies);
  const apiBackend = hasAnyDependency(dependencies, [
    "fastify", "express", "koa", "hapi", "@nestjs/core",
  ]);

  if (webFrontend) {
    checks.push(browserCheck(runs, scripts, dependencies, executedScripts, successfulCommands));
  }

  if (apiBackend) {
    checks.push(apiCheck(runs, scripts, executedScripts, successfulCommands));
  }

  return report(checks.some((check) => check.status === "failed") ? "failed" : "passed", checks);
}

/**
 * Real browser evidence, from either source that can actually produce it:
 * AllyCode's own browser_verify tool, or a third-party runner the project
 * installed itself. Demanding only the latter made the check unsatisfiable on a
 * machine without a downloaded browser binary, so a finished frontend could
 * never be accepted.
 */
function browserCheck(
  runs: ToolRun[],
  scripts: Record<string, unknown>,
  dependencies: Record<string, unknown>,
  executedScripts: Set<string>,
  successfulCommands: string[],
): CompletionCheck {
  const verifyRuns = runs.filter((run) => run.name === "browser_verify");
  const firstParty = verifyRuns.at(-1)?.succeeded ? verifyRuns.at(-1) : undefined;
  if (firstParty) {
    const url = stringValue(firstParty.input, "url") ?? "";
    return {
      id: "browser_e2e",
      label: "浏览器验证（按实际覆盖范围）",
      status: "passed",
      evidence: `browser_verify 仅证明真实浏览器渲染检查通过，业务交互仍需对应断言： ${url || "目标页面"}。`,
    };
  }

  const e2eScript = ["test:e2e", "e2e"].find((name) => typeof scripts[name] === "string");
  const realBrowserRunner = hasAnyDependency(dependencies, [
    "@playwright/test", "playwright", "cypress", "puppeteer", "puppeteer-core",
  ]);
  if (e2eScript && realBrowserRunner && executedScripts.has(e2eScript)) {
    return {
      id: "browser_e2e",
      label: "浏览器验证（按实际覆盖范围）",
      status: "passed",
      evidence: `${e2eScript} 已通过，并检测到真实浏览器测试运行器。`,
    };
  }

  // A runner invoked directly is real execution too, provided it sits at a
  // shell-statement boundary so an echoed string cannot forge the evidence.
  const directRunner = successfulCommands.find(isDirectBrowserRunnerCommand);
  if (directRunner) {
    return {
      id: "browser_e2e",
      label: "浏览器验证（按实际覆盖范围）",
      status: "passed",
      evidence: `检测到成功执行的浏览器测试运行器：${directRunner}`,
    };
  }

  const attempted = verifyRuns.length > 0;
  return {
    id: "browser_e2e",
    label: "浏览器验证（按实际覆盖范围）",
    status: "failed",
    evidence: attempted
      ? "browser_verify 已运行但未通过：页面存在导航失败、未渲染内容、缺失文案或未捕获的 JS 异常。" +
        "请按报告修复后重新验证，不要在失败状态下宣告完成。"
      : "检测到前端应用，但没有真实浏览器渲染证据。纯 Mock 测试不能替代真实 UI。" +
        "正确做法：service_start 启动前端（带 readyUrl）→ browser_verify 校验每条路由 → service_stop。",
  };
}

/**
 * API evidence. When the project declares an integration script, that script is
 * the contract. When it declares none, a health-verified server plus a real
 * request against it is still honest proof that the API runs — previously such
 * a project could never satisfy the gate at all.
 */
function apiCheck(
  runs: ToolRun[],
  scripts: Record<string, unknown>,
  executedScripts: Set<string>,
  successfulCommands: string[],
): CompletionCheck {
  const apiScript = ["test:integration", "test:api", "test:acceptance"].find((name) =>
    typeof scripts[name] === "string"
  );
  if (apiScript && executedScripts.has(apiScript)) {
    return {
      id: "api_integration",
      label: "真实 API 集成验收",
      status: "passed",
      evidence: `${apiScript} 已成功执行。`,
    };
  }
  if (apiScript) {
    return {
      id: "api_integration",
      label: "真实 API 集成验收",
      status: "failed",
      evidence: `package.json 声明了 ${apiScript}，但本轮没有成功执行证据。`,
    };
  }

  const healthChecked = runs.find((run) =>
    run.name === "service_start" && run.succeeded && stringValue(run.input, "readyUrl")
  );
  const exercised = successfulCommands.some(isLocalApiRequestCommand)
    || runs.some((run) => run.name === "web_fetch" && run.succeeded && isLoopback(stringValue(run.input, "url")));
  if (healthChecked && exercised) {
    return {
      id: "api_integration",
      label: "真实 API 集成验收",
      status: "passed",
      evidence: `服务 ${stringValue(healthChecked.input, "readyUrl")} 通过健康检查，并有成功的真实请求证据。`,
    };
  }
  return {
    id: "api_integration",
    label: "真实 API 集成验收",
    status: "failed",
    evidence: "检测到 API 服务，但既没有 integration/api/acceptance 脚本的成功执行证据，" +
      "也没有「service_start 健康检查通过 + 真实请求成功」的证据。",
  };
}

/**
 * A build tool alone is not a user interface. Treating `vite` as proof of a
 * frontend forced a browser check onto backend-only projects that could never
 * satisfy it.
 */
async function hasWebFrontend(
  cwd: string,
  dependencies: Record<string, unknown>,
): Promise<boolean> {
  const uiFramework = hasAnyDependency(dependencies, [
    "react", "react-dom", "next", "vue", "@angular/core", "svelte",
    "solid-js", "preact", "nuxt", "@remix-run/react",
  ]);
  if (uiFramework) return true;
  const bundler = hasAnyDependency(dependencies, ["vite", "parcel", "webpack", "@rsbuild/core"]);
  if (!bundler) return false;
  // A bundler plus a real HTML entry point does mean a browser UI ships.
  for (const candidate of ["index.html", "public/index.html", "src/index.html", "web/index.html"]) {
    try {
      await fs.access(path.join(cwd, candidate));
      return true;
    } catch { /* keep looking */ }
  }
  return false;
}

function isDirectBrowserRunnerCommand(command: string): boolean {
  return safeStatements(command).length === 1 && /^(?:npx\s+|pnpm\s+dlx\s+|yarn\s+dlx\s+)?(?:playwright|cypress)\s+(?:test|run)\b/i.test(command.trim());
}

function isLocalApiRequestCommand(command: string): boolean {
  if (safeStatements(command).length !== 1) return false;
  if (!/^(?:curl(?:\.exe)?|Invoke-RestMethod|Invoke-WebRequest|irm|iwr|http|wget)\b/i.test(command)) {
    return false;
  }
  return /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i.test(command);
}

function isLoopback(url: string | undefined): boolean {
  return typeof url === "string"
    && /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i.test(url);
}

function report(status: CompletionCheckStatus, checks: CompletionCheck[]): CompletionGateReport {
  const failed = checks.filter((check) => check.status === "failed");
  return {
    schemaVersion: 1,
    status,
    generatedAt: new Date().toISOString(),
    checks,
    summary: status === "passed"
      ? `执行证据检查通过（${checks.length} 项）；完成范围以各项证据为准。`
      : status === "not_applicable"
        ? "本任务不适用工程完成门禁。"
        : `独立完成门禁未通过：${failed.map((check) => check.label).join("、")}。`,
  };
}

async function validDocumentEvidence(cwd: string, run: ToolRun): Promise<boolean> {
  try {
    const artifact = record(run.metadata?.documentArtifact);
    if (!run.succeeded || typeof artifact.output !== "string" || !Array.isArray(artifact.sources) || !artifact.sources.length) return false;
    if (run.name === "document_verify" && resolveWorkspacePath(cwd, String(run.input.path)) !== resolveWorkspacePath(cwd, artifact.output)) return false;
    if (await hashDocument(resolveWorkspacePath(cwd, artifact.output)) !== artifact.sha256) return false;
    for (const item of artifact.sources) {
      const source = record(item);
      if (typeof source.path !== "string" || await hashDocument(resolveWorkspacePath(cwd, source.path)) !== source.sha256) return false;
    }
    return true;
  } catch { return false; }
}

async function validConversionEvidence(cwd:string,run:ToolRun):Promise<boolean> {
  try {
    const artifact=record(run.metadata?.convertedArtifact);
    return run.succeeded && typeof artifact.output==="string" && typeof artifact.source==="string" && Number(artifact.pages)>0 && await Promise.all([
      hashDocument(resolveWorkspacePath(cwd,artifact.output)).then(hash=>hash===artifact.sha256,()=>false),
      hashDocument(resolveWorkspacePath(cwd,artifact.source)).then(hash=>hash===artifact.sourceSha256,()=>false),
    ]).then(values=>values.every(Boolean));
  }catch{return false;}
}

async function readPackageJson(cwd: string): Promise<Record<string, unknown> | null> {
  try {
    const text = await fs.readFile(path.join(cwd, "package.json"), "utf8");
    return record(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

function collectToolRuns(events: TaskEventRecord[]): ToolRun[] {
  const starts = new Map<string, ToolRun>();
  for (const [sequence, event] of events.entries()) {
    const payload = record(event.payload);
    const toolId = stringValue(payload, "toolId");
    if (!toolId) continue;
    if (event.eventType === "agent_tool_start") {
      starts.set(`${event.runId ?? ""}:${toolId}`, {
        name: stringValue(payload, "toolName") ?? "unknown",
        input: record(payload["input"]),
        succeeded: false,
        result: "",
        startedAt: sequence,
        endedAt: -1,
        runId: event.runId,
      });
    } else if (event.eventType === "agent_tool_result") {
      const run = starts.get(`${event.runId ?? ""}:${toolId}`);
      if (run) {
        run.metadata = record(payload["metadata"]);
        run.endedAt = sequence;
        run.succeeded = payload["isError"] === false;
        run.result = stringValue(payload, "content") ?? "";
      }
    }
  }
  return [...starts.values()];
}

/** Only standalone commands and fail-fast && chains are provable from one exit code. */
function safeStatements(command: string): string[] {
  if (/--(?:prefix|cwd|dir|directory|workspace)\b|(?:^|&&)\s*(?:cd|Set-Location|pushd|popd)\b/i.test(command)) return [];
  if (/[;|\n\r\x60<>#]/.test(command) || /\$\(|(^|[^&])&([^&]|$)/.test(command)) return [];
  return command.split(/\s*&&\s*/).map((part) => part.trim()).filter(Boolean);
}

function expandExecutedScripts(commands: string[], scripts: Record<string, unknown>): Set<string> {
  const executed = new Set<string>();
  const visit = (command: string, seen: Set<string>) => {
    for (const statement of safeStatements(command)) {
      const match = /^(?:npm(?:\.cmd)?|pnpm(?:\.cmd)?|yarn(?:\.cmd)?)\s+(?:run\s+)?([\w:-]+)(?:\s+.*)?$/i.exec(statement);
      if (match?.[1]) {
        const name = match[1];
        const definition = scripts[name];
        if (typeof definition === "string" && safeStatements(definition).length && !/^\s*(?:echo|Write-Output|printf|true)(?:\s|$)/i.test(definition)) {
          executed.add(name);
          if (!seen.has(name)) { seen.add(name); visit(definition, seen); }
        }
      }
      for (const [name, definition] of Object.entries(scripts)) {
        if (typeof definition === "string" && safeStatements(definition).length && statement === definition.trim() && !/^(?:echo|Write-Output|printf|true)(?:\s|$)/i.test(statement)) executed.add(name);
      }
    }
  };
  commands.forEach((command) => visit(command, new Set()));
  return executed;
}

function isVerification(command: string, scripts: Record<string, unknown>): boolean {
  return expandExecutedScripts([command], scripts).size > 0 || isGenericVerificationCommand(command) || isDirectBrowserRunnerCommand(command) || isLocalApiRequestCommand(command);
}

function isReadOnlyCommand(command: string): boolean {
  const parts = safeStatements(command);
  return parts.length > 0 && parts.every((part) => /^(?:(?:git\s+(?:status|diff|log|show)|rg|cat|ls|pwd|Get-Content|Get-ChildItem|Get-Location)(?:\s|$))/i.test(part));
}

function isGenericVerificationCommand(command: string): boolean {
  const parts = safeStatements(command);
  return parts.length > 0 && parts.every((part) => /^(?:(?:npm|pnpm|yarn)\s+(?:test|run\s+(?:test|build|lint|typecheck))|(?:python(?:3)?\s+-m\s+)?pytest|(?:npx\s+)?(?:vitest|jest|tsc)|cargo\s+(?:test|check)|go\s+test|dotnet\s+test)(?:\s|$)/i.test(part));
}

/** Project-owned PowerShell suites, not echoed names, arbitrary shell blocks or outside paths. */
async function isProjectPowerShellTest(cwd: string, command: string): Promise<boolean> {
  if (safeStatements(command).length !== 1 || /[$`]/.test(command)) return false;
  const match = /^\s*(?:powershell|pwsh)(?:\.exe)?\s+(?:(?:-NoProfile|-NonInteractive|-ExecutionPolicy\s+Bypass)\s+)*-File\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"']+))(?:\s+-[\w-]+(?:\s+[\w.-]+)?)*\s*$/i.exec(command);
  const script = (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").replaceAll("\\", "/");
  if (!/^(?:\.\/)?tests?\/(?:[\w-]+\/)*(?:run[_-])?(?:test|e2e|verify|check)[\w.-]*\.ps1$/i.test(script)) return false;
  try {
    const root = await fs.realpath(cwd);
    const file = await fs.realpath(path.resolve(cwd, script));
    const relative = path.relative(root, file);
    return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative) && (await fs.stat(file)).isFile();
  } catch { return false; }
}

function hasAnyDependency(
  dependencies: Record<string, unknown>,
  names: string[],
): boolean {
  return names.some((name) => typeof dependencies[name] === "string");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown, key: string): string | undefined {
  const nested = record(value)[key];
  return typeof nested === "string" ? nested : undefined;
}
