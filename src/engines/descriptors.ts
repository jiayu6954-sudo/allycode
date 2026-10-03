import {
  AGENT_ENGINE_CONTRACT_VERSION,
  type AgentEngineDescriptor,
  type AgentEngineId,
} from "./types.js";

export const AGENT_ENGINE_DESCRIPTORS: Record<AgentEngineId, AgentEngineDescriptor> = {
  native: {
    contractVersion: AGENT_ENGINE_CONTRACT_VERSION,
    id: "native",
    name: "AllyCode 原生引擎",
    summary: "内置模型适配、长期记忆、Skills、MCP、权限与沙箱主链路。",
    maturity: "stable",
    capabilities: {
      streaming: true,
      resume: true,
      tools: true,
      skills: true,
      mcp: true,
      sandbox: true,
      trace: true,
      externalRuntime: false,
    },
  },
  codex: {
    contractVersion: AGENT_ENGINE_CONTRACT_VERSION,
    id: "codex",
    name: "Codex 引擎",
    summary: "通过本机 Codex CLI 的结构化 JSONL 接口运行，保留 Codex 自身沙箱与认证。",
    maturity: "beta",
    capabilities: {
      streaming: true,
      resume: true,
      tools: true,
      skills: true,
      mcp: true,
      sandbox: true,
      trace: true,
      externalRuntime: true,
    },
  },
  "deepseek-harness": {
    contractVersion: AGENT_ENGINE_CONTRACT_VERSION,
    id: "deepseek-harness",
    name: "DeepSeek Harness",
    summary: "面向 DSH 插件化运行时的隔离适配；开发预览版只在探测兼容后启用。",
    maturity: "developer-preview",
    capabilities: {
      streaming: true,
      resume: true,
      tools: true,
      skills: true,
      mcp: false,
      sandbox: true,
      trace: true,
      externalRuntime: true,
    },
  },
};
