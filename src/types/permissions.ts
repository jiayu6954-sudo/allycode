import type { ToolName, ToolInput } from "./tools.js";

export type PermissionLevel = "auto" | "ask" | "deny";

export interface PermissionRule {
  tool: ToolName | "*";
  inputPredicate?: (input: ToolInput) => boolean;
  level: PermissionLevel;
}

export interface PermissionRequest {
  /** Native tool name or MCP-qualified name (e.g. "notion__search_pages") */
  toolName: string;
  input: ToolInput | Record<string, unknown>;
  riskLevel: RiskLevel;
  description: string;
}

export type RiskLevel = "safe" | "moderate" | "dangerous";

export type PermissionDecision = "allow" | "deny" | "allow-session";
