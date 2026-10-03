import type { AgentEvent } from "../types/agent.js";

export const AGENT_ENGINE_CONTRACT_VERSION = 1 as const;

export type AgentEngineId = "native" | "codex" | "deepseek-harness";
export type AgentEngineMode = "auto" | AgentEngineId;
export type AgentEngineHealthState =
  | "ready"
  | "not_installed"
  | "needs_auth"
  | "incompatible"
  | "unavailable";

export interface AgentEngineCapabilities {
  streaming: boolean;
  resume: boolean;
  tools: boolean;
  skills: boolean;
  mcp: boolean;
  sandbox: boolean;
  trace: boolean;
  externalRuntime: boolean;
}

export interface AgentEngineDescriptor {
  contractVersion: typeof AGENT_ENGINE_CONTRACT_VERSION;
  id: AgentEngineId;
  name: string;
  summary: string;
  maturity: "stable" | "beta" | "developer-preview";
  capabilities: AgentEngineCapabilities;
}

export interface AgentEngineHealth {
  engine: AgentEngineDescriptor;
  state: AgentEngineHealthState;
  selectable: boolean;
  version?: string;
  detail: string;
  checkedAt: string;
}

export interface AgentEngineExecutionRequest {
  externalSessionId?: string;
  onSession?: (id: string) => void | Promise<void>;
  prompt: string;
  cwd: string;
  model?: string;
  signal?: AbortSignal;
  onEvent: (event: AgentEvent) => void;
  onTrace?: (eventType: string, payload: unknown) => void;
}

export interface AgentEngineExecutionResult {
  finalText: string;
  externalSessionId?: string;
}

export interface ExternalAgentEngine {
  readonly descriptor: AgentEngineDescriptor;
  health(command: string): Promise<AgentEngineHealth>;
  execute(command: string, request: AgentEngineExecutionRequest): Promise<AgentEngineExecutionResult>;
}
