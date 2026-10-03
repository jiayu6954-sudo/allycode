import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DATA_DIR } from "../src/config/settings.js";
import { execa } from "execa";
import { z } from "zod";
import type { BenchmarkLabState, BenchmarkRunReport } from "./shared.js";
import { assertSafeWorkspaceRoot } from "../src/tools/path-guard.js";

const CHALLENGE_ID = "binary-market-protocol-agent-challenge";
const TEMPLATE_NAME = "binary-market-protocol-challenge";
const WORKSPACE_NAME = "AllyCode-Binary-Market-Challenge";
const markerSchema = z.object({ schemaVersion: z.literal(1), challenge: z.literal(CHALLENGE_ID) });
const reportSchema = z.object({
  runId: z.string().optional(),
  challenge: z.literal(CHALLENGE_ID),
  generatedAt: z.string(),
  score: z.number(),
  total: z.number().positive(),
  results: z.array(z.object({
    id: z.string(),
    section: z.string(),
    points: z.number(),
    earned: z.number(),
    passed: z.boolean(),
    detail: z.string(),
  })),
  boundary: z.string(),
});

export class DesktopBenchmarkService {
  constructor(
    private readonly benchmarkRoot: string,
    private readonly runtimeExecutable: string,
  ) {}

  async state(workspace?: string): Promise<BenchmarkLabState> {
    return {
      id: CHALLENGE_ID,
      title: "Binary Market Protocol 工业级盲测",
      description: "基于公开高预算真实需求改编：从零交付 Solana/Anchor 合约、索引 API、React 前端、预言机结算与安全测试。",
      preparedWorkspace: workspace,
      latest: workspace ? await this.readReport(workspace) : undefined,
      principles: [
        "真实需求来源、模型、Agent 引擎、工具链环境和验收结果分别记录，禁止用宣传语代替证据。",
        "隐藏断言不复制进工作区；Agent 只能读取公开任务书、接口合同和评分维度。",
        "仅在本地模拟器或 devnet 验证，禁止连接主网、使用真钱、钱包私钥或执行金融交易。",
        "评分以可重复运行的接口、状态不变量和测试产物为准；工具链缺失单独标记，不伪装成通过。",
      ],
    };
  }

  async prepare(parentDirectory: string): Promise<string> {
    assertSafeWorkspaceRoot(parentDirectory);
    const source = this.templateDirectory();
    const workspace = await uniqueDirectory(parentDirectory, WORKSPACE_NAME);
    await fs.mkdir(workspace, { recursive: false });
    await fs.cp(source, workspace, {
      recursive: true,
      filter: (sourcePath) => {
        const relative = path.relative(source, sourcePath);
        if (!relative) return true;
        const first = relative.split(path.sep)[0];
        return first !== ".challenge" && first !== ".challenge-results" && first !== ".allycode-eval";
      },
    });
    await fs.writeFile(
      path.join(workspace, ".allycode-benchmark.json"),
      JSON.stringify({ schemaVersion: 1, challenge: CHALLENGE_ID }, null, 2),
      "utf8",
    );
    return workspace;
  }

  async run(workspace: string): Promise<BenchmarkRunReport> {
    assertSafeWorkspaceRoot(workspace);
    await this.assertPreparedWorkspace(workspace);
    const evaluator = path.join(this.templateDirectory(), ".challenge", "run-all.mjs");
    const runId = randomUUID();
    const reportRoot = this.reportDirectory(workspace);
    const outputDirectory = path.join(reportRoot, runId);
    await fs.mkdir(outputDirectory, { recursive: true });
    const evaluatorHash = createHash("sha256").update(await fs.readFile(evaluator)).digest("hex");
    const startedAt = Date.now();
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1", ALLYCODE_EVAL_RESULT_DIR: outputDirectory, ALLYCODE_EVAL_RUN_ID: runId };
    const result = await execa(this.runtimeExecutable, [evaluator], {
      cwd: workspace,
      env,
      reject: false,
      shell: false,
      windowsHide: true,
      timeout: 240_000,
    });
    const report = await this.readReportFile(path.join(outputDirectory, "latest.json"));
    if (!report || report.runId !== runId || Date.parse(report.generatedAt) < startedAt || result.timedOut) {
      const output = `${result.stdout}\n${result.stderr}`.trim().slice(-1_000);
      throw new Error(`外部验收未生成报告。${output}`);
    }
    await fs.writeFile(path.join(reportRoot, "latest.json"), JSON.stringify({ ...report, provenance: { runId, evaluatorHash, startedAt: new Date(startedAt).toISOString(), exitCode: result.exitCode } }), "utf8");
    return report;
  }

  private templateDirectory(): string {
    return path.join(this.benchmarkRoot, "projects", TEMPLATE_NAME);
  }

  private async assertPreparedWorkspace(workspace: string): Promise<void> {
    const markerPath = path.join(workspace, ".allycode-benchmark.json");
    const marker = markerSchema.parse(JSON.parse(await fs.readFile(markerPath, "utf8")));
    if (marker.challenge !== CHALLENGE_ID) throw new Error("评测工作区标记不匹配。");
  }

  private async readReport(workspace: string): Promise<BenchmarkRunReport | undefined> {
    return this.readReportFile(path.join(this.reportDirectory(workspace), "latest.json"));
  }

  private reportDirectory(workspace: string): string {
    return path.join(DATA_DIR, "benchmark-reports", createHash("sha256").update(path.resolve(workspace)).digest("hex"));
  }

  private async readReportFile(filePath: string): Promise<(BenchmarkRunReport & { runId?: string }) | undefined> {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return reportSchema.parse(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }
}

async function uniqueDirectory(parent: string, preferredName: string): Promise<string> {
  for (let index = 0; index < 100; index += 1) {
    const name = index === 0 ? preferredName : `${preferredName}-${index + 1}`;
    const candidate = path.join(parent, name);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
  throw new Error("无法创建唯一的评测项目目录。");
}
