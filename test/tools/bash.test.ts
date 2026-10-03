import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeBash } from "../../src/tools/bash.js";

describe("native shell lifecycle", () => {
  let tempDir = "";
  const spawnedPids: number[] = [];

  it.skipIf(process.platform !== "win32")("preserves native failure after a PowerShell diagnostic command", async()=>{
    tempDir=await fs.mkdtemp(path.join(os.tmpdir(),"ally-shell-exit-"));
    const result=await executeBash({command:'cmd /c "exit 7"; Write-Output "diagnostic"'},{cwd:tempDir,timeoutMs:10000});
    expect(result.isError).toBe(true);
    expect(result.metadata?.exitCode).toBe(7);
  });
  it.skipIf(process.platform !== "win32")("returns readable Chinese stdout and full Python traceback",async()=>{
    tempDir=await fs.mkdtemp(path.join(os.tmpdir(),"ally-shell-utf8-"));
    await fs.writeFile(path.join(tempDir,"fail.py"),"print('中文诊断', flush=True)\nraise ValueError('报告生成失败')\n");
    const result=await executeBash({command:"py -3 fail.py"},{cwd:tempDir,timeoutMs:10000});
    expect(result.isError).toBe(true);
    expect(result.content).toContain("中文诊断");
    expect(result.content).toContain("ValueError: 报告生成失败");
  });
  it.skipIf(process.platform !== "win32")("rejects Bash Python heredocs before PowerShell syntax noise",async()=>{
    tempDir=await fs.mkdtemp(path.join(os.tmpdir(),"ally-shell-heredoc-"));
    const result=await executeBash({command:"python - <<'PY'\nprint(1)\nPY"},{cwd:tempDir,timeoutMs:10000});
    expect(result.isError).toBe(true);expect(result.content).toContain("file_write");
  });

  afterEach(async () => {
    for (const pid of spawnedPids) {
      try { process.kill(pid); } catch { /* already terminated */ }
    }
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  });

  it.skipIf(process.platform !== "win32")(
    "terminates the complete Windows child tree when a command times out",
    async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "allycode-bash-tree-"));
      const pidFile = path.join(tempDir, "child.pid");
      const command = [
        "$child = Start-Process -FilePath 'ping.exe' -ArgumentList @('-n','120','127.0.0.1') -PassThru",
        `$child.Id | Set-Content -LiteralPath '${pidFile.replace(/'/g, "''")}'`,
        "Wait-Process -Id $child.Id",
      ].join("; ");

      const startedAt = Date.now();
      const result = await executeBash(
        { command, timeout: 1_200 },
        { cwd: tempDir, timeoutMs: 1_200 },
      );
      try {
        await fs.access(pidFile);
      } catch {
        throw new Error(`child pid file missing: ${result.content}`);
      }
      const pid = Number((await fs.readFile(pidFile, "utf8")).trim());
      spawnedPids.push(pid);

      expect(Date.now() - startedAt).toBeLessThan(10_000);
      expect(result.isError).toBe(true);
      expect(result.metadata?.exitCode).toBe(124);
      expect(result.content).toContain("tool returned control");
      await expectProcessToExit(pid);
    },
    15_000,
  );

  it.skipIf(process.platform !== "win32")(
    "terminates the complete Windows child tree when the user pauses",
    async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "allycode-bash-abort-"));
      const pidFile = path.join(tempDir, "child.pid");
      const command = [
        "$child = Start-Process -FilePath 'ping.exe' -ArgumentList @('-n','120','127.0.0.1') -PassThru",
        `$child.Id | Set-Content -LiteralPath '${pidFile.replace(/'/g, "''")}'`,
        "Wait-Process -Id $child.Id",
      ].join("; ");
      const controller = new AbortController();
      const abortHandle = setTimeout(() => controller.abort(), 1_200);

      const result = await executeBash(
        { command, timeout: 10_000 },
        { cwd: tempDir, timeoutMs: 10_000, signal: controller.signal },
      ).finally(() => clearTimeout(abortHandle));
      try {
        await fs.access(pidFile);
      } catch {
        throw new Error(`child pid file missing: ${result.content}`);
      }
      const pid = Number((await fs.readFile(pidFile, "utf8")).trim());
      spawnedPids.push(pid);

      expect(result.isError).toBe(true);
      expect(result.content).toContain("aborted by user");
      await expectProcessToExit(pid);
    },
    15_000,
  );

  it.skipIf(process.platform !== "win32")(
    "returns control when Start-Process detaches npm after its launcher exits",
    async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "allycode-bash-detached-"));
      const pidFile = path.join(tempDir, "child.pid");
      const stdoutFile = path.join(tempDir, "child.stdout.log");
      const stderrFile = path.join(tempDir, "child.stderr.log");
      await fs.writeFile(path.join(tempDir, "package.json"), JSON.stringify({
        name: "allycode-detached-process-fixture",
        private: true,
        scripts: { stay: "node -e \"setInterval(() => {}, 1000)\"" },
      }), "utf8");
      const escaped = (value: string): string => value.replace(/'/g, "''");
      const command = [
        `$child = Start-Process -FilePath 'npm.cmd' -ArgumentList @('run','stay') -WorkingDirectory '${escaped(tempDir)}' -PassThru -WindowStyle Hidden -RedirectStandardOutput '${escaped(stdoutFile)}' -RedirectStandardError '${escaped(stderrFile)}'`,
        `$child.Id | Set-Content -LiteralPath '${escaped(pidFile)}'`,
        "Write-Output \"started pid=$($child.Id)\"",
      ].join("; ");

      const startedAt = Date.now();
      const result = await executeBash(
        { command, timeout: 1_500 },
        { cwd: tempDir, timeoutMs: 1_500 },
      );
      const elapsed = Date.now() - startedAt;
      const pid = Number((await fs.readFile(pidFile, "utf8")).trim());
      spawnedPids.push(pid);

      expect(elapsed).toBeLessThan(10_000);
      expect(result.metadata?.exitCode).toBe(124);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("tool returned control");
      await expectProcessToExit(pid);
    },
    15_000,
  );
});

async function expectProcessToExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch {
      return;
    }
  }
  throw new Error(`child process ${pid} was not terminated`);
}
