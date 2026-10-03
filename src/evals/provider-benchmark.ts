/**
 * Reproducible provider/agent compatibility benchmark for AllyCode.
 *
 * This harness intentionally uses only synthetic prompts and synthetic tool
 * results. It measures the configured provider transport and model behavior;
 * it never executes a local tool and it never invents scores when a call fails.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { SettingsSchema, type AllyCodeSettings } from "../config/schema.js";
import { loadSettings } from "../config/settings.js";
import { createProvider } from "../providers/index.js";
import type {
  AIProvider,
  NormalizedMessage,
  ProviderProtocol,
  StreamParams,
} from "../providers/interface.js";
import type { ConversationMessage } from "../types/agent.js";
import type { ToolDefinition } from "../types/tools.js";

const ExactTextCaseSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("exact_text"),
  description: z.string().min(1),
  required: z.boolean().default(true),
  system: z.string(),
  prompt: z.string(),
  expectedText: z.string().min(1),
  maxOutputTokens: z.number().int().min(1).max(4096).optional(),
});

const ToolRoundtripCaseSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("tool_roundtrip"),
  description: z.string().min(1),
  required: z.boolean().default(true),
  system: z.string(),
  prompt: z.string(),
  tool: z.object({
    name: z.literal("grep"),
    description: z.string().min(1),
    inputSchema: z.object({
      type: z.literal("object"),
      properties: z.record(z.unknown()),
      required: z.array(z.string()),
    }),
  }),
  expectedInput: z.record(z.unknown()),
  syntheticResult: z.string(),
  expectedContinuationText: z.string().min(1),
  maxOutputTokens: z.number().int().min(1).max(4096).optional(),
});

const FalseExecutionCaseSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("false_execution_sentinel"),
  description: z.string().min(1),
  required: z.boolean().default(true),
  system: z.string(),
  prompt: z.string(),
  expectedText: z.string().min(1),
  forbiddenPatterns: z.array(z.string()).default([]),
  maxOutputTokens: z.number().int().min(1).max(4096).optional(),
});

const CacheObservationCaseSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("cache_observation"),
  description: z.string().min(1),
  required: z.boolean().default(false),
  system: z.string(),
  prefixSeed: z.string().min(1),
  repeatCount: z.number().int().min(16).max(2000),
  question: z.string(),
  expectedText: z.string().min(1),
  maxOutputTokens: z.number().int().min(1).max(4096).optional(),
});

export const BenchmarkSuiteSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  defaults: z.object({
    timeoutMs: z.number().int().min(1000).max(300_000),
    maxOutputTokens: z.number().int().min(1).max(4096),
  }),
  cases: z.array(z.discriminatedUnion("kind", [
    ExactTextCaseSchema,
    ToolRoundtripCaseSchema,
    FalseExecutionCaseSchema,
    CacheObservationCaseSchema,
  ])).min(1),
});

export type BenchmarkSuite = z.infer<typeof BenchmarkSuiteSchema>;
type BenchmarkCase = BenchmarkSuite["cases"][number];

interface CliOptions {
  provider?: AllyCodeSettings["provider"];
  model?: string;
  protocol?: AllyCodeSettings["providerProtocol"];
  reasoningMode?: AllyCodeSettings["reasoning"]["mode"];
  reasoningEffort?: AllyCodeSettings["reasoning"]["effort"];
  suitePath: string;
  outputPath?: string;
  timeoutMs?: number;
  json: boolean;
  help: boolean;
}

interface UsageMeasurement {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
}

interface ToolCallSummary {
  id: string;
  name: string;
  input: unknown;
}

interface CallMeasurement {
  label: string;
  ok: boolean;
  totalLatencyMs: number;
  firstSignalLatencyMs: number | null;
  text: string;
  textExcerpt: string;
  thinkingCharacters: number;
  toolCalls: ToolCallSummary[];
  usage: UsageMeasurement | null;
  stopReason: NormalizedMessage["stop_reason"] | null;
  error?: string;
}

interface SuccessfulCall {
  ok: true;
  message: NormalizedMessage;
  measurement: CallMeasurement;
}

interface FailedCall {
  ok: false;
  measurement: CallMeasurement;
}

type MeasuredCall = SuccessfulCall | FailedCall;

interface CheckResult {
  passed: boolean;
  required: boolean;
  detail: string;
}

interface CaseResult {
  id: string;
  kind: BenchmarkCase["kind"];
  description: string;
  required: boolean;
  passed: boolean;
  checks: Record<string, CheckResult>;
  calls: CallMeasurement[];
}

interface BenchmarkReport {
  schemaVersion: 1;
  runId: string;
  startedAt: string;
  finishedAt: string;
  configuration: {
    suiteId: string;
    provider: AllyCodeSettings["provider"];
    model: string;
    requestedProtocol: AllyCodeSettings["providerProtocol"];
    resolvedProtocol: ProviderProtocol | "provider_default";
    reasoningMode: AllyCodeSettings["reasoning"]["mode"];
    reasoningEffort: AllyCodeSettings["reasoning"]["effort"];
    timeoutMs: number;
  };
  environment: {
    node: string;
    platform: NodeJS.Platform;
    architecture: string;
  };
  summary: {
    requiredCases: number;
    passedRequiredCases: number;
    failedRequiredCases: number;
    suitePassRate: number;
    agentReadyForThisSuite: boolean;
    latencyMs: {
      callCount: number;
      mean: number | null;
      p50: number | null;
      p95: number | null;
      maximum: number | null;
      meanFirstSignal: number | null;
    };
    usage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      callsReportingCacheUsage: number;
      cacheObservation: "observed" | "not_observed_or_unreported";
    };
  };
  cases: CaseResult[];
  limitations: string[];
}

class BenchmarkConfigurationError extends Error {}

const DEFAULT_SUITE = path.join("benchmarks", "suites", "alpha9-agent-core.json");

export async function runProviderBenchmark(
  settings: AllyCodeSettings,
  suite: BenchmarkSuite,
  timeoutOverride?: number,
  providerOverride?: AIProvider,
): Promise<BenchmarkReport> {
  let provider: AIProvider;
  try {
    provider = providerOverride ?? createProvider(settings);
  } catch (error) {
    const detail = redactError(error);
    throw new BenchmarkConfigurationError(
      `无法创建 Provider，基准未运行，也不会生成推测分数。${detail}\n` +
      credentialHint(settings.provider),
    );
  }

  const startedAt = new Date();
  const timeoutMs = timeoutOverride ?? suite.defaults.timeoutMs;
  const results: CaseResult[] = [];
  for (const benchmarkCase of suite.cases) {
    results.push(await runCase(provider, settings, suite, benchmarkCase, timeoutMs));
  }

  const requiredCases = results.filter((result) => result.required);
  const passedRequiredCases = requiredCases.filter((result) => result.passed).length;
  const calls = results.flatMap((result) => result.calls).filter((call) => call.ok);
  const totalLatencies = calls.map((call) => call.totalLatencyMs);
  const firstSignalLatencies = calls
    .map((call) => call.firstSignalLatencyMs)
    .filter((latency): latency is number => latency !== null);
  const usages = calls
    .map((call) => call.usage)
    .filter((usage): usage is UsageMeasurement => usage !== null);
  const cacheReporting = usages.filter((usage) =>
    usage.cacheReadTokens !== null || usage.cacheCreationTokens !== null);
  const cacheReadTokens = sum(usages.map((usage) => usage.cacheReadTokens ?? 0));

  return {
    schemaVersion: 1,
    runId: randomUUID(),
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    configuration: {
      suiteId: suite.id,
      provider: settings.provider,
      model: settings.model,
      requestedProtocol: settings.providerProtocol,
      resolvedProtocol: provider.protocol ?? "provider_default",
      reasoningMode: settings.reasoning.mode,
      reasoningEffort: settings.reasoning.effort,
      timeoutMs,
    },
    environment: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
    },
    summary: {
      requiredCases: requiredCases.length,
      passedRequiredCases,
      failedRequiredCases: requiredCases.length - passedRequiredCases,
      suitePassRate: requiredCases.length === 0
        ? 1
        : round(passedRequiredCases / requiredCases.length, 4),
      agentReadyForThisSuite:
        requiredCases.length > 0 && passedRequiredCases === requiredCases.length,
      latencyMs: {
        callCount: calls.length,
        mean: mean(totalLatencies),
        p50: percentile(totalLatencies, 0.5),
        p95: percentile(totalLatencies, 0.95),
        maximum: totalLatencies.length > 0 ? Math.max(...totalLatencies) : null,
        meanFirstSignal: mean(firstSignalLatencies),
      },
      usage: {
        inputTokens: sum(usages.map((usage) => usage.inputTokens)),
        outputTokens: sum(usages.map((usage) => usage.outputTokens)),
        cacheReadTokens,
        cacheCreationTokens: sum(usages.map((usage) => usage.cacheCreationTokens ?? 0)),
        callsReportingCacheUsage: cacheReporting.length,
        cacheObservation: cacheReadTokens > 0 ? "observed" : "not_observed_or_unreported",
      },
    },
    cases: results,
    limitations: [
      "suitePassRate 只表示本套合成协议用例的通过率，不是通用智能、编码能力或国际排行榜分数。",
      "虚假执行哨兵只检查一个受控提示，不能等同于完整事实性或幻觉率评测。",
      "缓存指标来自 Provider 返回的 usage；零值可能表示未命中、未达到缓存门槛，或接口未上报。",
      "工具结果由测试框架合成，基准不会实际读取文件、运行命令或访问项目数据。",
      "长上下文、SWE-bench、网络搜索质量、安全红队与真实仓库任务需要独立且有预算控制的评测。",
    ],
  };
}

async function runCase(
  provider: AIProvider,
  settings: AllyCodeSettings,
  suite: BenchmarkSuite,
  benchmarkCase: BenchmarkCase,
  timeoutMs: number,
): Promise<CaseResult> {
  switch (benchmarkCase.kind) {
    case "exact_text":
      return runExactTextCase(provider, settings, suite, benchmarkCase, timeoutMs);
    case "tool_roundtrip":
      return runToolRoundtripCase(provider, settings, suite, benchmarkCase, timeoutMs);
    case "false_execution_sentinel":
      return runFalseExecutionCase(provider, settings, suite, benchmarkCase, timeoutMs);
    case "cache_observation":
      return runCacheObservationCase(provider, settings, suite, benchmarkCase, timeoutMs);
  }
}

async function runExactTextCase(
  provider: AIProvider,
  settings: AllyCodeSettings,
  suite: BenchmarkSuite,
  benchmarkCase: z.infer<typeof ExactTextCaseSchema>,
  timeoutMs: number,
): Promise<CaseResult> {
  const call = await measuredCall(provider, {
    model: settings.model,
    maxTokens: benchmarkCase.maxOutputTokens ?? suite.defaults.maxOutputTokens,
    systemPrompt: benchmarkCase.system,
    messages: [{ role: "user", content: benchmarkCase.prompt }],
    tools: [],
  }, timeoutMs, "基础对话");
  const exact = call.ok && normalizedText(call.message) === benchmarkCase.expectedText;
  return makeCaseResult(benchmarkCase, [call.measurement], {
    exact_text: {
      passed: exact,
      required: true,
      detail: call.ok
        ? `期望 ${JSON.stringify(benchmarkCase.expectedText)}，实际 ${JSON.stringify(normalizedText(call.message))}`
        : call.measurement.error ?? "调用失败",
    },
  });
}

async function runToolRoundtripCase(
  provider: AIProvider,
  settings: AllyCodeSettings,
  suite: BenchmarkSuite,
  benchmarkCase: z.infer<typeof ToolRoundtripCaseSchema>,
  timeoutMs: number,
): Promise<CaseResult> {
  const tool: ToolDefinition = {
    name: benchmarkCase.tool.name,
    description: benchmarkCase.tool.description,
    input_schema: benchmarkCase.tool.inputSchema,
  };
  const initialUser: ConversationMessage = { role: "user", content: benchmarkCase.prompt };
  const first = await measuredCall(provider, {
    model: settings.model,
    maxTokens: benchmarkCase.maxOutputTokens ?? suite.defaults.maxOutputTokens,
    systemPrompt: benchmarkCase.system,
    messages: [initialUser],
    tools: [tool],
  }, timeoutMs, "原生工具调用");

  const firstToolCalls = first.ok
    ? first.message.content.filter((block) => block.type === "tool_use")
    : [];
  const nativeToolPassed = firstToolCalls.length === 1 &&
    firstToolCalls[0]?.name === benchmarkCase.tool.name &&
    matchesSubset(firstToolCalls[0]?.input, benchmarkCase.expectedInput);

  const checks: Record<string, CheckResult> = {
    native_tool_call: {
      passed: nativeToolPassed,
      required: true,
      detail: first.ok
        ? `收到 ${firstToolCalls.length} 个工具调用；期望 1 个 ${benchmarkCase.tool.name}。`
        : first.measurement.error ?? "调用失败",
    },
  };
  const calls = [first.measurement];
  if (!first.ok || firstToolCalls.length === 0) {
    checks.tool_result_continuation = {
      passed: false,
      required: true,
      detail: "第一轮没有结构化工具调用，无法合法执行第二轮续接。",
    };
    return makeCaseResult(benchmarkCase, calls, checks);
  }

  const assistantMessage = normalizedAssistantMessage(first.message);
  const toolResults: ConversationMessage = {
    role: "user",
    content: firstToolCalls.map((block) => ({
      type: "tool_result" as const,
      tool_use_id: block.id,
      content: block.name === benchmarkCase.tool.name
        ? benchmarkCase.syntheticResult
        : "ALLYCODE_BENCHMARK_UNEXPECTED_TOOL",
      is_error: block.name !== benchmarkCase.tool.name,
    })),
  };
  const second = await measuredCall(provider, {
    model: settings.model,
    maxTokens: benchmarkCase.maxOutputTokens ?? suite.defaults.maxOutputTokens,
    systemPrompt: benchmarkCase.system,
    messages: [initialUser, assistantMessage, toolResults],
    tools: [tool],
  }, timeoutMs, "工具结果第二轮续接");
  calls.push(second.measurement);
  const continuationPassed = second.ok &&
    normalizedText(second.message) === benchmarkCase.expectedContinuationText &&
    !second.message.content.some((block) => block.type === "tool_use");
  checks.tool_result_continuation = {
    passed: continuationPassed,
    required: true,
    detail: second.ok
      ? `期望 ${JSON.stringify(benchmarkCase.expectedContinuationText)}，实际 ${JSON.stringify(normalizedText(second.message))}`
      : second.measurement.error ?? "调用失败",
  };
  return makeCaseResult(benchmarkCase, calls, checks);
}

async function runFalseExecutionCase(
  provider: AIProvider,
  settings: AllyCodeSettings,
  suite: BenchmarkSuite,
  benchmarkCase: z.infer<typeof FalseExecutionCaseSchema>,
  timeoutMs: number,
): Promise<CaseResult> {
  const call = await measuredCall(provider, {
    model: settings.model,
    maxTokens: benchmarkCase.maxOutputTokens ?? suite.defaults.maxOutputTokens,
    systemPrompt: benchmarkCase.system,
    messages: [{ role: "user", content: benchmarkCase.prompt }],
    tools: [],
  }, timeoutMs, "虚假执行声明哨兵");
  const text = call.ok ? normalizedText(call.message) : "";
  const forbiddenMatches = benchmarkCase.forbiddenPatterns.filter((pattern) =>
    new RegExp(pattern, "iu").test(text));
  const exact = call.ok && text === benchmarkCase.expectedText;
  const noForbiddenClaim = call.ok && forbiddenMatches.length === 0;
  return makeCaseResult(benchmarkCase, [call.measurement], {
    exact_sentinel: {
      passed: exact,
      required: true,
      detail: call.ok
        ? `期望 ${JSON.stringify(benchmarkCase.expectedText)}，实际 ${JSON.stringify(text)}`
        : call.measurement.error ?? "调用失败",
    },
    no_false_execution_phrase: {
      passed: noForbiddenClaim,
      required: true,
      detail: forbiddenMatches.length === 0
        ? "未命中受控的虚假执行声明模式。"
        : `命中 ${forbiddenMatches.length} 个禁止模式。`,
    },
  });
}

async function runCacheObservationCase(
  provider: AIProvider,
  settings: AllyCodeSettings,
  suite: BenchmarkSuite,
  benchmarkCase: z.infer<typeof CacheObservationCaseSchema>,
  timeoutMs: number,
): Promise<CaseResult> {
  const prefix = Array.from(
    { length: benchmarkCase.repeatCount },
    (_, index) => `${String(index).padStart(4, "0")}:${benchmarkCase.prefixSeed}`,
  ).join("\n");
  const prompt = `${prefix}\n\n${benchmarkCase.question}`;
  const params: Omit<StreamParams, "signal"> = {
    model: settings.model,
    maxTokens: benchmarkCase.maxOutputTokens ?? suite.defaults.maxOutputTokens,
    systemPrompt: benchmarkCase.system,
    messages: [{ role: "user", content: prompt }],
    tools: [],
  };
  const first = await measuredCall(provider, params, timeoutMs, "缓存基线");
  const second = await measuredCall(provider, params, timeoutMs, "相同前缀重复请求");
  const exact = first.ok && second.ok &&
    normalizedText(first.message) === benchmarkCase.expectedText &&
    normalizedText(second.message) === benchmarkCase.expectedText;
  const observed = (second.measurement.usage?.cacheReadTokens ?? 0) > 0;
  return makeCaseResult(benchmarkCase, [first.measurement, second.measurement], {
    repeated_response_integrity: {
      passed: exact,
      required: true,
      detail: exact ? "两次相同请求均返回预期哨兵。" : "至少一次请求失败或没有返回精确哨兵。",
    },
    cache_usage_observed: {
      passed: observed,
      required: false,
      detail: observed
        ? `第二次请求上报缓存读取 ${second.measurement.usage?.cacheReadTokens ?? 0} tokens。`
        : "第二次请求未上报缓存命中；这不是该信息型用例的失败条件。",
    },
  });
}

async function measuredCall(
  provider: AIProvider,
  params: Omit<StreamParams, "signal">,
  timeoutMs: number,
  label: string,
): Promise<MeasuredCall> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  let firstSignalAt: number | null = null;
  let thinkingCharacters = 0;
  try {
    const handle = provider.stream({ ...params, signal: controller.signal });
    for await (const delta of handle.deltas()) {
      if (firstSignalAt === null) firstSignalAt = performance.now();
      if (delta.type === "thinking") thinkingCharacters += delta.text.length;
    }
    const message = await handle.finalMessage();
    const finished = performance.now();
    const text = normalizedText(message);
    const measurement: CallMeasurement = {
      label,
      ok: true,
      totalLatencyMs: round(finished - started, 1),
      firstSignalLatencyMs: firstSignalAt === null ? null : round(firstSignalAt - started, 1),
      text,
      textExcerpt: excerpt(text),
      thinkingCharacters,
      toolCalls: message.content
        .filter((block) => block.type === "tool_use")
        .map((block) => ({ id: block.id, name: block.name, input: block.input })),
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? null,
        cacheCreationTokens: message.usage.cache_creation_input_tokens ?? null,
      },
      stopReason: message.stop_reason,
    };
    return { ok: true, message, measurement };
  } catch (error) {
    const finished = performance.now();
    return {
      ok: false,
      measurement: {
        label,
        ok: false,
        totalLatencyMs: round(finished - started, 1),
        firstSignalLatencyMs: firstSignalAt === null ? null : round(firstSignalAt - started, 1),
        text: "",
        textExcerpt: "",
        thinkingCharacters,
        toolCalls: [],
        usage: null,
        stopReason: null,
        error: controller.signal.aborted
          ? `调用超过 ${timeoutMs}ms，已中止。`
          : redactError(error),
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

function normalizedAssistantMessage(message: NormalizedMessage): ConversationMessage {
  return {
    role: "assistant",
    content: message.content.map((block) => block.type === "text"
      ? { type: "text" as const, text: block.text }
      : {
          type: "tool_use" as const,
          id: block.id,
          name: block.name,
          input: block.input,
        }),
    ...(message.providerState ? { providerState: message.providerState } : {}),
  };
}

function makeCaseResult(
  benchmarkCase: BenchmarkCase,
  calls: CallMeasurement[],
  checks: Record<string, CheckResult>,
): CaseResult {
  const requiredChecks = Object.values(checks).filter((check) => check.required);
  return {
    id: benchmarkCase.id,
    kind: benchmarkCase.kind,
    description: benchmarkCase.description,
    required: benchmarkCase.required,
    passed: requiredChecks.every((check) => check.passed),
    checks,
    calls,
  };
}

function normalizedText(message: NormalizedMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

function matchesSubset(actual: unknown, expected: Record<string, unknown>): boolean {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  const record = actual as Record<string, unknown>;
  return Object.entries(expected).every(([key, value]) =>
    JSON.stringify(record[key]) === JSON.stringify(value));
}

function credentialHint(provider: AllyCodeSettings["provider"]): string {
  const envNames: Partial<Record<AllyCodeSettings["provider"], string>> = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
    qwen: "DASHSCOPE_API_KEY",
    groq: "GROQ_API_KEY",
    gemini: "GEMINI_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    moonshot: "MOONSHOT_API_KEY",
  };
  const envName = envNames[provider];
  if (!envName) {
    return provider === "ollama"
      ? "请先启动本地模型服务，或在 AllyCode 设置中配置本地服务地址。"
      : "请在 AllyCode 设置中配置自定义地址/密钥；基准不会从命令行参数接收密钥。";
  }
  return `请只在当前进程环境中设置 ${envName} 后重试。桌面安全密钥库不会被独立 Node 基准脚本解密。`;
}

function redactError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/(?:sk|tvly)-[A-Za-z0-9_-]{12,}/g, "[已隐藏密钥]")
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [已隐藏]")
    .slice(0, 1000);
}

function excerpt(text: string): string {
  return text.length <= 300 ? text : `${text.slice(0, 300)}…`;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : round(sum(values) / values.length, 1);
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index] ?? null;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function loadSuite(suitePath: string): Promise<BenchmarkSuite> {
  let raw: string;
  try {
    raw = await fs.readFile(suitePath, "utf8");
  } catch (error) {
    throw new BenchmarkConfigurationError(`无法读取基准套件 ${suitePath}：${redactError(error)}`);
  }
  try {
    return BenchmarkSuiteSchema.parse(JSON.parse(raw) as unknown);
  } catch (error) {
    throw new BenchmarkConfigurationError(`基准套件格式无效 ${suitePath}：${redactError(error)}`);
  }
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    suitePath: DEFAULT_SUITE,
    json: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--json") options.json = true;
    else if (argument === "--provider") options.provider = readValue(argv, ++index, argument) as CliOptions["provider"];
    else if (argument === "--model") options.model = readValue(argv, ++index, argument);
    else if (argument === "--protocol") options.protocol = readValue(argv, ++index, argument) as CliOptions["protocol"];
    else if (argument === "--reasoning-mode") options.reasoningMode = readValue(argv, ++index, argument) as CliOptions["reasoningMode"];
    else if (argument === "--reasoning-effort") options.reasoningEffort = readValue(argv, ++index, argument) as CliOptions["reasoningEffort"];
    else if (argument === "--suite") options.suitePath = readValue(argv, ++index, argument);
    else if (argument === "--output") options.outputPath = readValue(argv, ++index, argument);
    else if (argument === "--timeout-ms") {
      const value = Number(readValue(argv, ++index, argument));
      if (!Number.isInteger(value) || value < 1000 || value > 300_000) {
        throw new BenchmarkConfigurationError("--timeout-ms 必须是 1000 到 300000 之间的整数。");
      }
      options.timeoutMs = value;
    } else {
      throw new BenchmarkConfigurationError(`未知参数：${argument}。使用 --help 查看说明。`);
    }
  }
  return options;
}

function readValue(argv: string[], index: number, option: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new BenchmarkConfigurationError(`${option} 缺少值。`);
  }
  return value;
}

function printHelp(): void {
  process.stdout.write(`AllyCode Provider/Agent 基准（Alpha.9）\n\n` +
    `用法：\n` +
    `  npm run benchmark:provider -- [选项]\n\n` +
    `选项：\n` +
    `  --provider <名称>          覆盖设置中的 Provider\n` +
    `  --model <模型ID>           覆盖设置中的模型\n` +
    `  --protocol <协议>          auto|anthropic|chat_completions|responses\n` +
    `  --reasoning-mode <模式>    auto|enabled|disabled\n` +
    `  --reasoning-effort <级别>  auto|low|medium|high|max|xhigh\n` +
    `  --suite <路径>             默认 benchmarks/suites/alpha9-agent-core.json\n` +
    `  --timeout-ms <毫秒>        单次调用超时（1000-300000）\n` +
    `  --output <路径>            保存完整 JSON 报告\n` +
    `  --json                     仅向标准输出写 JSON\n` +
    `  -h, --help                 显示帮助\n\n` +
    `说明：此命令会产生真实 API 调用和费用，但不会执行任何本地工具。\n` +
    `密钥请使用 Provider 的标准环境变量，不要放在命令行参数或 suite 文件中。\n`);
}

function printHumanReport(report: BenchmarkReport): void {
  const { configuration, summary } = report;
  process.stdout.write(
    `\nAllyCode Alpha.9 Provider/Agent 基准\n` +
    `Provider: ${configuration.provider}\n` +
    `Model: ${configuration.model}\n` +
    `Protocol: ${configuration.resolvedProtocol}（请求 ${configuration.requestedProtocol}）\n` +
    `Suite: ${configuration.suiteId}\n\n`,
  );
  for (const result of report.cases) {
    const mark = result.passed ? "PASS" : "FAIL";
    process.stdout.write(`[${mark}] ${result.id} — ${result.description}\n`);
    for (const [name, check] of Object.entries(result.checks)) {
      const checkMark = check.passed ? "✓" : check.required ? "✗" : "·";
      process.stdout.write(`  ${checkMark} ${name}: ${check.detail}\n`);
    }
  }
  process.stdout.write(
    `\n必测用例：${summary.passedRequiredCases}/${summary.requiredCases}，` +
    `本套件通过率 ${(summary.suitePassRate * 100).toFixed(1)}%\n` +
    `平均延迟：${summary.latencyMs.mean ?? "N/A"}ms；` +
    `P95：${summary.latencyMs.p95 ?? "N/A"}ms\n` +
    `Tokens：input ${summary.usage.inputTokens} / output ${summary.usage.outputTokens} / ` +
    `cache-read ${summary.usage.cacheReadTokens}\n` +
    `缓存观察：${summary.usage.cacheObservation}\n` +
    `结论：${summary.agentReadyForThisSuite ? "通过本套 Alpha.9 合成协议门槛" : "未通过本套 Alpha.9 合成协议门槛"}\n` +
    `注意：这不是通用能力或国际排行榜分数；完整边界见 JSON 报告 limitations。\n`,
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const loaded = await loadSettings();
  let settings: AllyCodeSettings;
  try {
    settings = SettingsSchema.parse({
      ...loaded,
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.protocol ? { providerProtocol: options.protocol } : {}),
      reasoning: {
        ...loaded.reasoning,
        ...(options.reasoningMode ? { mode: options.reasoningMode } : {}),
        ...(options.reasoningEffort ? { effort: options.reasoningEffort } : {}),
      },
    });
  } catch (error) {
    throw new BenchmarkConfigurationError(`Provider 参数无效：${redactError(error)}`);
  }
  const suitePath = path.resolve(options.suitePath);
  const suite = await loadSuite(suitePath);
  const report = await runProviderBenchmark(settings, suite, options.timeoutMs);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.outputPath) {
    const outputPath = path.resolve(options.outputPath);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, json, "utf8");
  }
  if (options.json) process.stdout.write(json);
  else {
    printHumanReport(report);
    if (options.outputPath) process.stdout.write(`完整报告：${path.resolve(options.outputPath)}\n`);
  }
  if (!report.summary.agentReadyForThisSuite) process.exitCode = 1;
}

const isMain = process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    const message = redactError(error);
    process.stderr.write(`基准未完成：${message}\n`);
    process.exitCode = error instanceof BenchmarkConfigurationError ? 2 : 1;
  });
}
