import type { AllyCodeSettings } from "../config/schema.js";
import { CodexCliEngine } from "./codex-cli.js";
import { DeepSeekHarnessEngine } from "./deepseek-harness.js";
import { AGENT_ENGINE_DESCRIPTORS } from "./descriptors.js";
import type {
  AgentEngineHealth,
  AgentEngineId,
  ExternalAgentEngine,
} from "./types.js";

const externalEngines: Record<Exclude<AgentEngineId, "native">, ExternalAgentEngine> = {
  codex: new CodexCliEngine(),
  "deepseek-harness": new DeepSeekHarnessEngine(),
};

export async function inspectAgentEngines(settings: AllyCodeSettings): Promise<AgentEngineHealth[]> {
  const checkedAt = new Date().toISOString();
  const native: AgentEngineHealth = {
    engine: AGENT_ENGINE_DESCRIPTORS.native,
    state: "ready",
    selectable: true,
    version: process.env.npm_package_version,
    detail: "内置运行时已就绪。",
    checkedAt,
  };
  const [codex, harness] = await Promise.all([
    externalEngines.codex.health(settings.agentEngine.codexCommand),
    externalEngines["deepseek-harness"].health(settings.agentEngine.deepseekHarnessCommand),
  ]);
  return [native, codex, harness];
}

export function resolveAgentEngine(settings: AllyCodeSettings): AgentEngineId {
  return settings.agentEngine.mode === "auto" ? "native" : settings.agentEngine.mode;
}

export function getExternalAgentEngine(id: Exclude<AgentEngineId, "native">): ExternalAgentEngine {
  return externalEngines[id];
}

export function commandForEngine(
  settings: AllyCodeSettings,
  id: Exclude<AgentEngineId, "native">,
): string {
  return id === "codex"
    ? settings.agentEngine.codexCommand
    : settings.agentEngine.deepseekHarnessCommand;
}
