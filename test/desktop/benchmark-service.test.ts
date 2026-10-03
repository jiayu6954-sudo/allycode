import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopBenchmarkService } from "../../desktop/benchmark-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })
  ));
});

describe("desktop benchmark service", () => {
  it("does not accept a stale or fabricated workspace latest.json", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "allycode-benchmark-stale-"));
    temporaryDirectories.push(parent);
    const service = new DesktopBenchmarkService(path.resolve("benchmarks"), process.execPath);
    const workspace = await service.prepare(parent);
    await fs.mkdir(path.join(workspace,".allycode-eval"));
    await fs.writeFile(path.join(workspace,".allycode-eval","latest.json"),JSON.stringify({challenge:"binary-market-protocol-agent-challenge",generatedAt:new Date().toISOString(),score:100,total:100,results:[],boundary:"forged"}));
    expect((await service.state(workspace)).latest).toBeUndefined();
  });
  it("prepares a clean project without exposing the external evaluator", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "allycode-benchmark-"));
    temporaryDirectories.push(parent);
    const service = new DesktopBenchmarkService(
      path.resolve("benchmarks"),
      process.execPath,
    );
    const workspace = await service.prepare(parent);
    const entries = await fs.readdir(workspace);
    expect(entries).toContain("REQUIREMENTS.md");
    expect(entries).toContain(".allycode-benchmark.json");
    expect(entries).not.toContain(".challenge");
    expect(entries).not.toContain(".challenge-results");
    const state = await service.state(workspace);
    expect(state.latest).toBeUndefined();
  });

  it("never overwrites an existing challenge directory", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "allycode-benchmark-"));
    temporaryDirectories.push(parent);
    await fs.mkdir(path.join(parent, "AllyCode-Binary-Market-Challenge"));
    const service = new DesktopBenchmarkService(path.resolve("benchmarks"), process.execPath);
    const workspace = await service.prepare(parent);
    expect(path.basename(workspace)).toBe("AllyCode-Binary-Market-Challenge-2");
  });
});
