import { createInterface } from "node:readline";
import { execa } from "execa";
import { AGENT_ENGINE_DESCRIPTORS } from "./descriptors.js";
import { runEngineCommand } from "./process-utils.js";
import type {
  AgentEngineExecutionRequest,
  AgentEngineExecutionResult,
  AgentEngineHealth,
  ExternalAgentEngine,
} from "./types.js";

interface CodexJsonEvent {
  type?: string;
  thread_id?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cached_input_tokens?: number;
  };
  item?: {
    id?: string;
    type?: string;
    text?: string;
    command?: string;
    aggregated_output?: string;
    exit_code?: number;
    status?: string;
  };
  error?: { message?: string } | string;
  message?: string;
}

export class CodexCliEngine implements ExternalAgentEngine {
  readonly descriptor = AGENT_ENGINE_DESCRIPTORS.codex;

  async health(command: string): Promise<AgentEngineHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const versionResult = await runEngineCommand(command, ["--version"]);
      if (versionResult.failed) {
        return this.result("not_installed", false, "未找到可执行的 Codex CLI。", checkedAt);
      }
      const version = firstLine(versionResult.stdout || versionResult.stderr);
      const authResult = await runEngineCommand(command, ["login", "status"]);
      const authText = `${authResult.stdout}\n${authResult.stderr}`.trim();
      if (authResult.failed || /not logged in|未登录/i.test(authText)) {
        return this.result(
          "needs_auth",
          false,
          "已安装，但 Codex 尚未登录。请先在终端运行 codex login。",
          checkedAt,
          version,
        );
      }
      return this.result("ready", true, "CLI 与登录状态均已通过检测。", checkedAt, version);
    } catch (error) {
      return this.result(
        isMissingExecutable(error) ? "not_installed" : "unavailable",
        false,
        isMissingExecutable(error)
          ? "未找到可执行的 Codex CLI。"
          : `Codex 检测失败：${errorMessage(error)}`,
        checkedAt,
      );
    }
  }

  async execute(
    command: string,
    request: AgentEngineExecutionRequest,
  ): Promise<AgentEngineExecutionResult> {
    const args = [
      "exec",
      "--json",
      "--color",
      "never",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "-C",
      request.cwd,
    ];
    if (request.model?.trim()) args.push("--model", request.model.trim());
    if (request.externalSessionId) {
      if (!/^[a-f0-9-]{36}$/i.test(request.externalSessionId)) throw new Error("外部会话 ID 无效");
      args.push("resume", "--json", request.externalSessionId);
    }
    args.push("-");

    request.onEvent({ type: "status", phase: "waiting_model", iteration: 1 });
    const subprocess = execa(command, args, {
      cwd: request.cwd,
      reject: false,
      shell: false,
      windowsHide: true,
      cancelSignal: request.signal,
      env: childEnvironment(),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    subprocess.stdin?.end(request.prompt);

    let finalText = "";
    let externalSessionId: string | undefined;
    let stderr = "";
    const runningTools = new Map<string, { name: string; input: unknown }>();

    const stdoutReader = createInterface({ input: subprocess.stdout! });
    const stderrReader = createInterface({ input: subprocess.stderr! });
    const stderrPromise = (async () => {
      for await (const line of stderrReader) {
        stderr += `${line}\n`;
        request.onTrace?.("external_stderr", { engine: "codex", line: safeExternalError(line, "[已隐藏敏感诊断]") });
      }
    })();

    for await (const line of stdoutReader) {
      if (!line.trim()) continue;
      let event: CodexJsonEvent;
      try {
        event = JSON.parse(line) as CodexJsonEvent;
      } catch {
        request.onTrace?.("external_protocol_warning", {
          engine: "codex",
          message: "收到非 JSONL 标准输出",
        });
        continue;
      }
      request.onTrace?.("external_protocol_event", { engine: "codex", type: event.type, itemType: event.item?.type, itemId: event.item?.id });
      if (event.type === "thread.started" && event.thread_id) {
        externalSessionId = event.thread_id;
        await request.onSession?.(externalSessionId);
      }
      if (event.type === "turn.started") {
        request.onEvent({ type: "stream_signal", signal: "thinking", iteration: 1 });
      }
      if (event.type === "item.started" && event.item) {
        const mapped = mapTool(event.item);
        if (mapped) {
          runningTools.set(mapped.id, { name: mapped.name, input: mapped.input });
          request.onEvent({
            type: "tool_start",
            toolId: mapped.id,
            toolName: mapped.name,
            input: mapped.input,
          });
        }
      }
      if (event.type === "item.completed" && event.item) {
        if (event.item.type === "agent_message" && event.item.text) {
          finalText += event.item.text;
          request.onEvent({ type: "stream_signal", signal: "text", iteration: 1 });
          request.onEvent({ type: "text_delta", delta: event.item.text });
        } else {
          const mapped = mapTool(event.item);
          if (mapped || (event.item.id && runningTools.has(event.item.id))) {
            const prior = event.item.id ? runningTools.get(event.item.id) : undefined;
            if (!prior && mapped) request.onEvent({ type: "tool_start", toolId: mapped.id, toolName: mapped.name, input: mapped.input });
            const toolId = event.item.id ?? mapped!.id;
            const toolName = mapped?.name ?? prior!.name;
            const output = event.item.aggregated_output ?? event.item.text ?? event.item.status ?? "已完成";
            request.onEvent({
              type: "tool_result",
              toolId,
              toolName,
              content: output,
              isError: event.item.status === "failed" || (typeof event.item.exit_code === "number" && event.item.exit_code !== 0),
            });
            runningTools.delete(toolId);
          }
        }
      }
      if (event.type === "turn.completed" && event.usage) {
        request.onEvent({
          type: "usage",
          inputTokens: Math.max(0, (event.usage.input_tokens ?? 0) - (event.usage.cached_input_tokens ?? 0)),
          outputTokens: event.usage.output_tokens ?? 0,
          cacheReadTokens: event.usage.cached_input_tokens ?? 0,
          cacheWriteTokens: 0,
        });
      }
      if (event.type === "error" || event.type === "turn.failed") {
        const message = typeof event.error === "string"
          ? event.error
          : event.error?.message ?? event.message ?? "Codex 执行失败";
        request.onEvent({ type: "error", error: new Error(message) });
      }
    }

    await stderrPromise;
    const result = await subprocess;
    if (result.exitCode !== 0) {
      throw new Error(safeExternalError(stderr, `Codex 退出码 ${result.exitCode}`));
    }
    request.onEvent({ type: "done", stopReason: "external_engine_complete" });
    return { finalText, externalSessionId };
  }

  private result(
    state: AgentEngineHealth["state"],
    selectable: boolean,
    detail: string,
    checkedAt: string,
    version?: string,
  ): AgentEngineHealth {
    return { engine: this.descriptor, state, selectable, version, detail, checkedAt };
  }
}

function mapTool(item: NonNullable<CodexJsonEvent["item"]>):
  | { id: string; name: string; input: unknown }
  | undefined {
  if (!item.id || !item.type || item.type === "agent_message" || item.type === "reasoning") return undefined;
  const name = item.type === "command_execution" ? "bash" : `codex:${item.type}`;
  return {
    id: item.id,
    name,
    input: item.command ? { command: item.command } : { type: item.type },
  };
}

function firstLine(value: string): string | undefined {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

function childEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingExecutable(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function safeExternalError(stderr: string, fallback: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/api[_-]?key|authorization|bearer/i.test(line));
  return lines.at(-1)?.slice(0, 600) ?? fallback;
}
