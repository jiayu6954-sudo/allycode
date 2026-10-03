import type { TaskEventRecord } from "../storage/agent-database.js";
import type { CompletionGateReport } from "./completion-gate.js";

/**
 * Delivery receipt — reconciles what the assistant DECLARED against what the
 * persisted tool evidence PROVES, and states the difference in language an
 * ordinary person can act on.
 *
 * The assistant's prose is never an input. A step counts as done only when a
 * tool result of the right kind actually succeeded. When no such evidence
 * exists, the receipt says so instead of inventing a verdict — an honest
 * "cannot verify" is the whole point, because the reader cannot check for
 * themselves.
 */

export type ClaimVerdict = "verified" | "contradicted" | "unverifiable";

export interface ReceiptClaim {
  step: string;
  declared: "completed" | "in_progress" | "pending";
  verdict: ClaimVerdict;
  evidence: string;
}

export interface ReceiptArtifact {
  kind: "file" | "screenshot" | "log";
  path: string;
}

export interface DeliveryReceipt {
  schemaVersion: 1;
  generatedAt: string;
  /** delivered = every declared step is backed by evidence and the gate passed. */
  outcome: "delivered" | "partial" | "not_delivered" | "nothing_declared";
  headline: string;
  claims: ReceiptClaim[];
  facts: EvidenceFacts;
  artifacts: ReceiptArtifact[];
  /** Things the reader has to decide or do. Written for a non-engineer. */
  nextForYou: string[];
}

interface EvidenceFacts {
  filesWritten: string[];
  commandsSucceeded: number;
  commandsFailed: number;
  commandsTimedOut: number;
  testsPassed: boolean;
  buildPassed: boolean;
  servicesHealthy: string[];
  pagesVerified: string[];
  pagesFailed: string[];
}

interface ToolRun {
  name: string;
  input: Record<string, unknown>;
  succeeded: boolean;
  result: string;
}

interface PlanItem {
  step: string;
  status: "completed" | "in_progress" | "pending";
}

/** Which kind of proof a declared step needs before it may be called done. */
type ProofKind = "test" | "ui" | "service" | "build" | "doc" | "code";

/**
 * A step may need several kinds of proof at once. Matching only the first
 * pattern let "打通 npm run start:test 一次启动 API+Web 并端到端验证" be graded as a
 * test — the script NAME contains "test" — and an unrelated passing unit-test
 * run then certified a service that never started. Every matching kind is
 * required, and the word-boundary rules below refuse to read a script name
 * such as `start:test` or `test-server` as evidence of testing.
 */
const PROOF_PATTERNS: Array<{ kind: ProofKind; pattern: RegExp }> = [
  { kind: "test", pattern: /测试|单测|用例|\bvitest\b|\bjest\b|\bpytest\b|(?<![:\w-])tests?(?![:\w-])/i },
  { kind: "ui", pattern: /前端|界面|页面|视图|路由|浏览器|\bUI\b|react|vue|svelte|angular/i },
  { kind: "service", pattern: /启动|服务|端到端|start:test|\be2e\b|\bserver\b|\bapi\b/i },
  { kind: "build", pattern: /编译|构建|打包|\bbuild\b|compile|\btsc\b|cargo\s+build/i },
  { kind: "doc", pattern: /文档|说明|readme|威胁模型|架构|指南|手册/i },
];

/** The step itself admits it did not get that far — respect the declaration. */
const DECLARED_GAP = /(?:未|没有|无法|不再?)\s*(?:编译|构建|打包|运行|启动|验证)/;

export function buildDeliveryReceipt(
  events: TaskEventRecord[],
  gate?: CompletionGateReport | null,
): DeliveryReceipt {
  const runs = collectToolRuns(events);
  const facts = summariseEvidence(runs);
  const plan = latestPlan(events);
  const claims = plan.map((item) => judge(item, facts));
  const artifacts = collectArtifacts(runs);

  const contradicted = claims.filter((claim) => claim.verdict === "contradicted");
  const unverifiable = claims.filter((claim) => claim.verdict === "unverifiable");
  const gateFailed = gate?.status === "failed";

  const outcome: DeliveryReceipt["outcome"] = plan.length === 0
    ? "nothing_declared"
    : contradicted.length > 0 || gateFailed
      ? "not_delivered"
      : unverifiable.length > 0
        ? "partial"
        : "delivered";

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    outcome,
    headline: headlineFor(outcome, claims, contradicted.length, unverifiable.length),
    claims,
    facts,
    artifacts,
    nextForYou: nextSteps(outcome, contradicted, unverifiable, facts, gate),
  };
}

function headlineFor(
  outcome: DeliveryReceipt["outcome"],
  claims: ReceiptClaim[],
  contradicted: number,
  unverifiable: number,
): string {
  const declaredDone = claims.filter((claim) => claim.declared === "completed").length;
  switch (outcome) {
    case "nothing_declared":
      return "这次没有可对账的计划，下面只列出实际发生过的操作。";
    case "delivered":
      return `${claims.length} 项计划全部完成，而且每一项都有实际运行证据。`;
    case "partial":
      return `声称完成 ${declaredDone} 项，其中 ${unverifiable} 项我无法拿出证据证明它真的能用。`;
    case "not_delivered":
      return contradicted > 0
        ? `⚠️ 声称完成 ${declaredDone} 项，但有 ${contradicted} 项与实际运行记录矛盾 —— 这些没有真正做到。`
        : "⚠️ 独立验收没有通过，这次交付不能算完成。";
  }
}

function judge(item: PlanItem, facts: EvidenceFacts): ReceiptClaim {
  if (item.status !== "completed") {
    return {
      step: item.step,
      declared: item.status,
      verdict: "unverifiable",
      evidence: item.status === "in_progress" ? "还在进行中。" : "还没开始。",
    };
  }

  const required = requiredProofs(item.step);
  const outcomes = required.map((kind) => checkProof(kind, item.step, facts));

  // One missing proof is enough to sink the claim: a step that needs both a
  // running service and a rendered page is not done when only one holds.
  const failed = outcomes.filter((outcome) => outcome.verdict === "contradicted");
  if (failed.length > 0) {
    return verdict(item, "contradicted", failed.map((outcome) => outcome.evidence).join(" "));
  }
  const unproven = outcomes.filter((outcome) => outcome.verdict === "unverifiable");
  if (unproven.length > 0) {
    return verdict(item, "unverifiable", unproven.map((outcome) => outcome.evidence).join(" "));
  }
  return verdict(item, "verified", outcomes.map((outcome) => outcome.evidence).join(" "));
}

function checkProof(
  kind: ProofKind,
  step: string,
  facts: EvidenceFacts,
): { verdict: ClaimVerdict; evidence: string } {
  switch (kind) {
    case "test":
      return facts.testsPassed
        ? { verdict: "verified", evidence: "有测试命令成功退出的记录。" }
        : { verdict: "contradicted", evidence: "没有任何测试命令成功运行过 —— 声称「测试通过」但测试从未跑通。" };
    case "ui":
      if (facts.pagesVerified.length > 0) {
        return { verdict: "verified", evidence: `真实浏览器打开并渲染成功：${facts.pagesVerified.join("、")}。` };
      }
      return {
        verdict: "contradicted",
        evidence: facts.pagesFailed.length > 0
          ? `真实浏览器打开页面失败：${facts.pagesFailed.join("、")}。界面并没有真的能用。`
          : "页面从未在真实浏览器里打开过 —— 写了代码不等于界面能用。",
      };
    case "service":
      if (facts.servicesHealthy.length > 0) {
        return { verdict: "verified", evidence: `服务启动并通过健康检查：${facts.servicesHealthy.join("、")}。` };
      }
      return {
        verdict: "contradicted",
        evidence: facts.commandsTimedOut > 0
          ? `服务从未成功启动过（有 ${facts.commandsTimedOut} 次命令卡死被强制终止）。`
          : "服务从未成功启动并响应过请求。",
      };
    case "build":
      if (facts.buildPassed) return { verdict: "verified", evidence: "有构建/编译命令成功退出的记录。" };
      return DECLARED_GAP.test(step)
        ? { verdict: "unverifiable", evidence: "这一步本身就声明了没有编译，因此没有核验。" }
        : { verdict: "contradicted", evidence: "没有构建或编译成功的记录。" };
    case "doc":
      return facts.filesWritten.some((file) => /\.(md|txt|rst)$/i.test(file))
        ? { verdict: "verified", evidence: "文档文件已写入磁盘。" }
        : { verdict: "unverifiable", evidence: "没有看到文档文件被写入。" };
    case "code":
      return facts.filesWritten.length > 0
        ? {
            verdict: "unverifiable",
            evidence: `代码文件已写入（${facts.filesWritten.length} 个），但「文件存在」不等于「功能可用」，这一项没有运行证据。`,
          }
        : { verdict: "contradicted", evidence: "没有任何文件被写入。" };
  }
}

function verdict(item: PlanItem, result: ClaimVerdict, evidence: string): ReceiptClaim {
  return { step: item.step, declared: "completed", verdict: result, evidence };
}

/** Every proof kind the wording implies. Falls back to `code` only when none match. */
export function requiredProofs(step: string): ProofKind[] {
  const kinds = PROOF_PATTERNS.filter(({ pattern }) => pattern.test(step)).map(({ kind }) => kind);
  return kinds.length > 0 ? kinds : ["code"];
}

function summariseEvidence(runs: ToolRun[]): EvidenceFacts {
  const filesWritten = new Set<string>();
  let commandsSucceeded = 0;
  let commandsFailed = 0;
  let commandsTimedOut = 0;
  let testsPassed = false;
  let buildPassed = false;
  const servicesHealthy: string[] = [];
  const pagesVerified: string[] = [];
  const pagesFailed: string[] = [];

  for (const run of runs) {
    switch (run.name) {
      case "file_write":
      case "file_edit": {
        const file = stringValue(run.input, "path") ?? stringValue(run.input, "file_path");
        if (run.succeeded && file) filesWritten.add(file);
        break;
      }
      case "bash": {
        const command = stringValue(run.input, "command") ?? "";
        if (/timed out after \d+ms/i.test(run.result)) commandsTimedOut++;
        if (run.succeeded) {
          commandsSucceeded++;
          if (isTestCommand(command)) testsPassed = true;
          if (isBuildCommand(command)) buildPassed = true;
        } else {
          commandsFailed++;
        }
        break;
      }
      case "service_start": {
        // Only a health-checked start proves the service actually answers.
        const ready = stringValue(run.input, "readyUrl");
        if (run.succeeded && ready) servicesHealthy.push(ready);
        break;
      }
      case "browser_verify": {
        const url = stringValue(run.input, "url") ?? "(页面)";
        (run.succeeded ? pagesVerified : pagesFailed).push(url);
        break;
      }
      default:
        break;
    }
  }

  return {
    filesWritten: [...filesWritten],
    commandsSucceeded,
    commandsFailed,
    commandsTimedOut,
    testsPassed,
    buildPassed,
    servicesHealthy,
    pagesVerified,
    pagesFailed,
  };
}

function isTestCommand(command: string): boolean {
  return /(?:^|[;&|]\s*)(?:npm|pnpm|yarn)\s+(?:run\s+)?test(?::[\w-]+)?\b|\b(?:vitest|jest|pytest|cargo\s+test|go\s+test|dotnet\s+test)\b/i
    .test(command);
}

function isBuildCommand(command: string): boolean {
  return /(?:^|[;&|]\s*)(?:npm|pnpm|yarn)\s+(?:run\s+)?build\b|\b(?:tsc|cargo\s+build|go\s+build|vite\s+build|webpack)\b/i
    .test(command);
}

function collectArtifacts(runs: ToolRun[]): ReceiptArtifact[] {
  const artifacts: ReceiptArtifact[] = [];
  const seen = new Set<string>();
  const add = (kind: ReceiptArtifact["kind"], path: string): void => {
    const key = `${kind}:${path}`;
    if (path && !seen.has(key)) { seen.add(key); artifacts.push({ kind, path }); }
  };
  for (const run of runs) {
    if (!run.succeeded) continue;
    if (run.name === "file_write" || run.name === "file_edit") {
      add("file", stringValue(run.input, "path") ?? "");
    } else if (run.name === "browser_verify") {
      const shot = stringValue(run.input, "screenshotPath");
      if (shot) add("screenshot", shot);
    } else if (run.name === "service_start") {
      const name = stringValue(run.input, "name");
      if (name) add("log", `.allycode/services/${name}.log`);
    }
  }
  return artifacts;
}

function nextSteps(
  outcome: DeliveryReceipt["outcome"],
  contradicted: ReceiptClaim[],
  unverifiable: ReceiptClaim[],
  facts: EvidenceFacts,
  gate?: CompletionGateReport | null,
): string[] {
  const steps: string[] = [];
  if (outcome === "delivered") {
    steps.push("可以直接使用。上面每一条都有对应的运行证据。");
    return steps;
  }
  for (const claim of contradicted.slice(0, 4)) {
    steps.push(`「${shorten(claim.step)}」并没有真的做到：${claim.evidence}`);
  }
  if (facts.commandsTimedOut > 0) {
    steps.push(`有 ${facts.commandsTimedOut} 次命令卡死后被强制结束，中间的操作可能没有完整执行。`);
  }
  for (const check of gate?.checks ?? []) {
    if (check.status === "failed") steps.push(`独立验收未通过 —— ${check.label}：${check.evidence}`);
  }
  if (unverifiable.length > 0 && contradicted.length === 0) {
    steps.push(`有 ${unverifiable.length} 项只写了代码、没有运行验证。要我实际跑一遍验证吗？`);
  }
  if (steps.length === 0) steps.push("没有可执行的后续动作。");
  return steps;
}

function shorten(text: string): string {
  return text.length > 28 ? `${text.slice(0, 28)}…` : text;
}

/**
 * The most recent plan the assistant published, recovered from the durable
 * event log. A checkpoint written by a run that never re-issued plan_update
 * carries no plan, so reading the checkpoint alone silently loses it — the
 * declaration half of the receipt then disappears and nothing can be
 * reconciled. The event log always still has it.
 */
export function latestDeclaredPlan(events: TaskEventRecord[]): PlanItem[] {
  return latestPlan(events);
}

function latestPlan(events: TaskEventRecord[]): PlanItem[] {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.eventType !== "agent_plan_update") continue;
    const items = record(event.payload)["items"];
    if (!Array.isArray(items)) continue;
    return items
      .map((entry) => {
        const row = record(entry);
        const step = typeof row["step"] === "string" ? row["step"] : "";
        const status = row["status"];
        if (!step) return null;
        return {
          step,
          status: status === "completed" || status === "in_progress" ? status : "pending",
        } satisfies PlanItem;
      })
      .filter((item): item is PlanItem => item !== null);
  }
  return [];
}

function collectToolRuns(events: TaskEventRecord[]): ToolRun[] {
  const starts = new Map<string, ToolRun>();
  const order: ToolRun[] = [];
  for (const event of events) {
    const payload = record(event.payload);
    const toolId = stringValue(payload, "toolId");
    if (!toolId) continue;
    if (event.eventType === "agent_tool_start") {
      const run: ToolRun = {
        name: stringValue(payload, "toolName") ?? "unknown",
        input: record(payload["input"]),
        succeeded: false,
        result: "",
      };
      starts.set(toolId, run);
      order.push(run);
    } else if (event.eventType === "agent_tool_result") {
      const run = starts.get(toolId);
      if (run) {
        run.succeeded = payload["isError"] !== true;
        run.result = stringValue(payload, "content") ?? "";
      }
    }
  }
  return order;
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

// ── Human-readable rendering ─────────────────────────────────────────────────

/**
 * Renders the receipt for someone who cannot read a stack trace. Every line
 * either states a proven fact or admits the absence of proof.
 */
export function renderReceipt(receipt: DeliveryReceipt, taskTitle?: string): string {
  const lines: string[] = [];
  if (taskTitle) lines.push(`任务：${taskTitle}`, "");
  lines.push(receipt.headline, "");

  const verified = receipt.claims.filter((claim) => claim.verdict === "verified");
  const contradicted = receipt.claims.filter((claim) => claim.verdict === "contradicted");
  const unverifiable = receipt.claims.filter((claim) => claim.verdict === "unverifiable");

  if (verified.length > 0) {
    lines.push("✅ 确实做到了（有运行证据）");
    for (const claim of verified) lines.push(`   · ${claim.step}`, `     ${claim.evidence}`);
    lines.push("");
  }
  if (contradicted.length > 0) {
    lines.push("❌ 说做完了，但证据不支持");
    for (const claim of contradicted) lines.push(`   · ${claim.step}`, `     ${claim.evidence}`);
    lines.push("");
  }
  if (unverifiable.length > 0) {
    lines.push("❓ 无法核验");
    for (const claim of unverifiable) lines.push(`   · ${claim.step}`, `     ${claim.evidence}`);
    lines.push("");
  }

  const facts = receipt.facts;
  lines.push("📋 实际发生过的事（与措辞无关，只看记录）");
  lines.push(`   · 写入文件 ${facts.filesWritten.length} 个`);
  lines.push(`   · 命令成功 ${facts.commandsSucceeded} 次，失败 ${facts.commandsFailed} 次` +
    (facts.commandsTimedOut > 0 ? `，卡死被强制结束 ${facts.commandsTimedOut} 次` : ""));
  lines.push(`   · 测试跑通：${facts.testsPassed ? "是" : "否"}    构建通过：${facts.buildPassed ? "是" : "否"}`);
  lines.push(`   · 服务真正启动并响应：${facts.servicesHealthy.length > 0 ? facts.servicesHealthy.join("、") : "没有"}`);
  lines.push(`   · 页面在真实浏览器中打开：${
    facts.pagesVerified.length > 0 ? facts.pagesVerified.join("、") : "没有"
  }`);
  lines.push("");

  if (receipt.artifacts.length > 0) {
    lines.push("📎 你可以打开看的东西");
    for (const artifact of receipt.artifacts.slice(0, 12)) {
      const label = artifact.kind === "screenshot" ? "截图" : artifact.kind === "log" ? "运行日志" : "文件";
      lines.push(`   · [${label}] ${artifact.path}`);
    }
    if (receipt.artifacts.length > 12) lines.push(`   · …另有 ${receipt.artifacts.length - 12} 个`);
    lines.push("");
  }

  lines.push("👉 接下来需要你决定的");
  for (const step of receipt.nextForYou) lines.push(`   · ${step}`);
  return lines.join("\n");
}
