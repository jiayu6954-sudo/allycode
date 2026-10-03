import type { TaskEventRecord } from "../storage/agent-database.js";
import type { ConversationMessage } from "../types/agent.js";

/**
 * Durable task state — what a resumed run needs to know without re-reading the
 * whole project.
 *
 * Every field is DERIVED from persisted events, and every derived item carries
 * the tool-call ids that produced it. The assistant's prose is never promoted
 * to fact: anything it merely asserted lands in `assertions`, labelled as
 * unverified, so a resumed run cannot inherit a claim as though it were
 * evidence. This is the same discipline as the delivery receipt, applied to
 * working memory instead of the final report.
 *
 * Free-text summaries alone cannot carry this: a summary can quietly drop the
 * one unresolved error that matters, and nothing downstream can tell.
 */

export interface EvidenceRef {
  /** Tool call ids in the persisted event log that support this item. */
  evidence: string[];
}

/**
 * A plan step the model MARKED complete. That marking is a declaration, never
 * a verified fact — `plan_update` is model output, and nothing about writing it
 * proves the work happened. `candidateEvidence` is keyword-matched and may be
 * coincidental, so it is never called proof either.
 */
export interface DeclaredStep {
  step: string;
  /** Keyword-matched tool calls that MIGHT relate. Candidates, not proof. */
  candidateEvidence: string[];
  status: "declared_without_evidence" | "declared_with_candidates";
}

export interface ModifiedFile extends EvidenceRef {
  path: string;
  writes: number;
}

export interface TestRun extends EvidenceRef {
  command: string;
  passed: boolean;
}

export interface UnresolvedError extends EvidenceRef {
  tool: string;
  summary: string;
  /** True when the identical invocation was retried and still failed. */
  repeated: boolean;
}

export interface DurableTaskState {
  schemaVersion: 1;
  derivedAt: string;
  /** The user's original request, taken verbatim from the canonical record. */
  goal: string | null;
  plan: Array<{ step: string; status: "pending" | "in_progress" | "completed" }>;
  currentStep: string | null;
  /** Steps the model marked complete. Declarations awaiting verification. */
  declaredComplete: DeclaredStep[];
  modifiedFiles: ModifiedFile[];
  testsRun: TestRun[];
  unresolvedErrors: UnresolvedError[];
  /** Model-stated claims with no supporting tool evidence. Never facts. */
  assertions: string[];
  /** What a resumed run should do first, derived from state above. */
  nextAction: string;
}

interface ToolRun {
  id: string;
  name: string;
  input: Record<string, unknown>;
  succeeded: boolean;
  result: string;
}

export function deriveTaskState(
  events: TaskEventRecord[],
  canonicalHistory: ConversationMessage[] = [],
): DurableTaskState {
  const runs = collectToolRuns(events);
  const plan = latestPlan(events);
  const completedPlanSteps = plan.filter((item) => item.status === "completed");

  const modifiedFiles = collectModifiedFiles(runs);
  const testsRun = collectTestRuns(runs);
  const unresolvedErrors = collectUnresolvedErrors(runs);

  const state: DurableTaskState = {
    schemaVersion: 1,
    derivedAt: new Date().toISOString(),
    goal: firstUserText(canonicalHistory),
    plan,
    currentStep: plan.find((item) => item.status === "in_progress")?.step ?? null,
    // A step the model marked complete is recorded with whatever candidates
    // exist — possibly none. The empty list is the signal, not a reason to
    // omit the step or to quietly upgrade it to done.
    declaredComplete: completedPlanSteps.map((item) => {
      const candidateEvidence = evidenceForStep(item.step, runs);
      return {
        step: item.step,
        candidateEvidence,
        status: candidateEvidence.length === 0
          ? "declared_without_evidence" as const
          : "declared_with_candidates" as const,
      };
    }),
    modifiedFiles,
    testsRun,
    unresolvedErrors,
    assertions: [],
    nextAction: "",
  };
  state.nextAction = deriveNextAction(state);
  return state;
}

/** The opening request, which must survive every trim and every resume. */
function firstUserText(history: ConversationMessage[]): string | null {
  for (const message of history) {
    if (message.role !== "user") continue;
    if (typeof message.content === "string" && message.content.trim()) {
      return message.content.trim();
    }
  }
  return null;
}

function collectModifiedFiles(runs: ToolRun[]): ModifiedFile[] {
  const byPath = new Map<string, ModifiedFile>();
  for (const run of runs) {
    if (!run.succeeded) continue;
    if (run.name !== "file_write" && run.name !== "file_edit") continue;
    const filePath = stringValue(run.input, "path") ?? stringValue(run.input, "file_path");
    if (!filePath) continue;
    const existing = byPath.get(filePath);
    if (existing) {
      existing.writes++;
      existing.evidence.push(run.id);
    } else {
      byPath.set(filePath, { path: filePath, writes: 1, evidence: [run.id] });
    }
  }
  return [...byPath.values()];
}

const TEST_COMMAND = /(?:^|[;&|]\s*)(?:npm|pnpm|yarn)\s+(?:run\s+)?test(?::[\w-]+)?\b|\b(?:vitest|jest|pytest|cargo\s+test|go\s+test|dotnet\s+test)\b/i;

function collectTestRuns(runs: ToolRun[]): TestRun[] {
  const out: TestRun[] = [];
  for (const run of runs) {
    if (run.name !== "bash") continue;
    const command = stringValue(run.input, "command") ?? "";
    if (!TEST_COMMAND.test(command)) continue;
    out.push({ command, passed: run.succeeded, evidence: [run.id] });
  }
  return out;
}

/**
 * Resolution is a question of ORDER, not of presence.
 *
 * Only a success that happens AFTER a failure clears it. Ignoring order made
 * `success → failure` read as resolved (the build broke and the state said it
 * was fine) and `failure → success → failure` read as resolved too. Both are
 * exactly the regressions a resumed run must not inherit.
 *
 * `repeated` counts the failure streak since the last success for that same
 * call, so an old streak that was later fixed and broke once more does not
 * masquerade as a stuck loop.
 */
function collectUnresolvedErrors(runs: ToolRun[]): UnresolvedError[] {
  interface Tracker {
    tool: string;
    lastOutcome: "success" | "failure";
    /** Failures since the most recent success — reset by every success. */
    streak: ToolRun[];
  }
  const byKey = new Map<string, Tracker>();
  const order: string[] = [];

  for (const run of runs) {
    const key = runKey(run);
    let tracker = byKey.get(key);
    if (!tracker) {
      tracker = { tool: run.name, lastOutcome: run.succeeded ? "success" : "failure", streak: [] };
      byKey.set(key, tracker);
      order.push(key);
    }
    if (run.succeeded) {
      tracker.lastOutcome = "success";
      tracker.streak = [];
    } else {
      tracker.lastOutcome = "failure";
      tracker.streak.push(run);
    }
  }

  const out: UnresolvedError[] = [];
  for (const key of order) {
    const tracker = byKey.get(key)!;
    if (tracker.lastOutcome !== "failure" || tracker.streak.length === 0) continue;
    const latest = tracker.streak[tracker.streak.length - 1]!;
    out.push({
      tool: tracker.tool,
      summary: firstMeaningfulLine(latest.result) || `${tracker.tool} 失败，未返回可读错误`,
      repeated: tracker.streak.length > 1,
      evidence: tracker.streak.map((run) => run.id),
    });
  }
  return out;
}

function runKey(run: ToolRun): string {
  return `${run.name}:${JSON.stringify(run.input)}`;
}

function firstMeaningfulLine(result: string): string {
  for (const line of result.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0 && !/^\[/.test(trimmed)) return trimmed.slice(0, 200);
  }
  return "";
}

/**
 * Tool ids whose input mentions the step's distinctive terms.
 *
 * This is keyword overlap, nothing more. A match may be coincidental and a
 * miss may be real work, so the result is only ever CANDIDATE evidence — the
 * caller must not present it as verification. An empty list honestly means
 * "nothing in the log even looks related".
 */
function evidenceForStep(step: string, runs: ToolRun[]): string[] {
  // Splitting on whitespace finds almost nothing in Chinese, which has none —
  // so Chinese steps usually yield an empty candidate list. That errs toward
  // "no evidence", which is the safe direction here, but it does mean the
  // candidate list is far weaker than it looks. Phase C's evidence artifacts
  // are meant to replace this heuristic, not refine it.
  const terms = step
    .split(/[\s、，,()（）/]+/)
    .filter((term) => term.length >= 3 && !/^[的与和及或在把为]+$/.test(term))
    .slice(0, 6)
    .map((term) => term.toLowerCase());
  if (terms.length === 0) return [];
  const matched: string[] = [];
  for (const run of runs) {
    if (!run.succeeded) continue;
    const haystack = JSON.stringify(run.input).toLowerCase();
    if (terms.some((term) => haystack.includes(term))) matched.push(run.id);
    if (matched.length >= 5) break;
  }
  return matched;
}

function deriveNextAction(state: DurableTaskState): string {
  if (state.unresolvedErrors.length > 0) {
    const first = state.unresolvedErrors[0]!;
    const loop = first.repeated ? "（同一调用已重复失败，换方法而不是重试）" : "";
    return `先修复未解决的错误：${first.tool} — ${first.summary}${loop}`;
  }
  if (state.currentStep) return `继续进行中的步骤：${state.currentStep}`;
  const pending = state.plan.find((item) => item.status === "pending");
  if (pending) return `开始下一步：${pending.step}`;
  if (state.plan.length === 0) return "尚无计划，先用 plan_update 声明可验证的步骤。";

  // Every step is marked done. That is a claim, and a claim with nothing
  // behind it is the failure mode this whole system exists to catch — so the
  // next action is to produce the missing evidence, never to ship.
  const unproven = state.declaredComplete.filter(
    (item) => item.status === "declared_without_evidence",
  );
  if (unproven.length > 0) {
    return `全部步骤被标记完成，但其中 ${unproven.length} 项没有任何工具证据 ——` +
      `先补验证再谈交付。第一项：${unproven[0]!.step}`;
  }
  return "各步均已标记完成且有候选证据，但候选证据未经核验；先实际运行验证，再谈交付。";
}

/**
 * Compact rendering for a resumed run's working context.
 *
 * Two things this must never do: print a ✓ next to a step whose only support
 * is that the model said so, and close with a blanket claim that everything
 * above is verified. Both were present in the first version, and together they
 * handed a resumed run a fabricated "done" to build on.
 */
export function renderTaskState(state: DurableTaskState): string {
  const lines: string[] = ["## 任务状态（由持久事件推导；标注为「声明」的项未经核验）"];
  if (state.goal) lines.push(`原始目标：${state.goal.slice(0, 500)}`);
  if (state.plan.length > 0) {
    const candidatesFor = new Map(
      state.declaredComplete.map((item) => [item.step, item.candidateEvidence.length]),
    );
    lines.push("计划：");
    for (const item of state.plan) {
      if (item.status === "completed") {
        const candidates = candidatesFor.get(item.step) ?? 0;
        lines.push(
          candidates === 0
            ? `  [声明完成·无证据] ${item.step}`
            : `  [声明完成·${candidates} 处候选证据未核验] ${item.step}`,
        );
      } else {
        lines.push(`  ${item.status === "in_progress" ? "▶" : "·"} ${item.step}`);
      }
    }
  }
  if (state.modifiedFiles.length > 0) {
    lines.push(`已修改文件（${state.modifiedFiles.length}）：${state.modifiedFiles.map((file) => file.path).slice(0, 20).join("、")}`);
  }
  if (state.testsRun.length > 0) {
    const passed = state.testsRun.filter((test) => test.passed).length;
    lines.push(`已执行测试：${state.testsRun.length} 次，成功 ${passed} 次`);
  }
  if (state.unresolvedErrors.length > 0) {
    lines.push("未解决的错误：");
    for (const error of state.unresolvedErrors.slice(0, 5)) {
      lines.push(`  · [${error.tool}] ${error.summary}${error.repeated ? "（已重复失败）" : ""}`);
    }
  }
  if (state.assertions.length > 0) {
    lines.push("模型自述但无证据（不可当作已完成）：");
    for (const claim of state.assertions.slice(0, 5)) lines.push(`  · ${claim}`);
  }
  const unproven = state.declaredComplete.filter(
    (item) => item.status === "declared_without_evidence",
  );
  if (unproven.length > 0) {
    lines.push(
      `⚠ ${unproven.length} 项被标记完成但没有任何工具证据：` +
      `${unproven.map((item) => item.step).slice(0, 5).join("、")}。` +
      "不得把它们当作已完成继续往下走。",
    );
  }
  lines.push(`下一步：${state.nextAction}`);
  lines.push(
    "已修改文件、已执行测试、未解决错误来自持久工具证据；" +
    "计划状态与候选证据均未经核验。需要细节时重新读取文件或重跑工具，不要凭记忆假设。",
  );
  return lines.join("\n");
}

// ── shared event decoding ───────────────────────────────────────────────────

function collectToolRuns(events: TaskEventRecord[]): ToolRun[] {
  const starts = new Map<string, ToolRun>();
  const order: ToolRun[] = [];
  for (const event of events) {
    const payload = record(event.payload);
    const toolId = stringValue(payload, "toolId");
    if (!toolId) continue;
    if (event.eventType === "agent_tool_start") {
      const run: ToolRun = {
        id: toolId,
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

function latestPlan(events: TaskEventRecord[]): DurableTaskState["plan"] {
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
        } as const;
      })
      .filter((item): item is DurableTaskState["plan"][number] => item !== null);
  }
  return [];
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
