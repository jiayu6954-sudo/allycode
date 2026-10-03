import { AGENT_ENGINE_DESCRIPTORS } from "./descriptors.js";
import { runEngineCommand } from "./process-utils.js";
import type {
  AgentEngineExecutionRequest,
  AgentEngineExecutionResult,
  AgentEngineHealth,
  ExternalAgentEngine,
} from "./types.js";

export class DeepSeekHarnessEngine implements ExternalAgentEngine {
  readonly descriptor = AGENT_ENGINE_DESCRIPTORS["deepseek-harness"];

  async health(command: string): Promise<AgentEngineHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const result = await runEngineCommand(command, ["--version"]);
      if (result.failed) {
        return {
          engine: this.descriptor,
          state: "not_installed",
          selectable: false,
          detail: "未安装 DeepSeek Harness。AllyCode 不会静默联网安装外部运行时。",
          checkedAt,
        };
      }
      return {
        engine: this.descriptor,
        state: "incompatible",
        selectable: false,
        version: firstLine(result.stdout || result.stderr),
        detail: "检测到开发预览版，但当前版本尚无稳定的非交互协议，已隔离禁用以避免误执行。",
        checkedAt,
      };
    } catch (error) {
      const missing = error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
      return {
        engine: this.descriptor,
        state: missing ? "not_installed" : "unavailable",
        selectable: false,
        detail: missing
          ? "未安装 DeepSeek Harness。AllyCode 不会静默联网安装外部运行时。"
          : `DeepSeek Harness 检测失败：${error instanceof Error ? error.message : String(error)}`,
        checkedAt,
      };
    }
  }

  async execute(
    _command: string,
    _request: AgentEngineExecutionRequest,
  ): Promise<AgentEngineExecutionResult> {
    throw new Error("DeepSeek Harness 的稳定非交互协议尚未通过兼容性验证，当前不可执行。");
  }
}

function firstLine(value: string): string | undefined {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}
