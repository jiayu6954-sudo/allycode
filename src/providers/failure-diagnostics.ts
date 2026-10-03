import type { NormalizedMessage } from "./interface.js";
export interface ProviderFailureDiagnostic {
  code: "http_error" | "empty_response" | "reasoning_only_limit" | "reasoning_only_response";
  httpStatus?: number;
  finishReason?: "stop" | "length" | "tool_calls" | "content_filter" | "unknown";
  hasReasoning?: boolean;
  usageReported: boolean;
}
/** Carries only explicitly selected metadata, never the response body or reasoning. */
export class ProviderFailure extends Error {
  constructor(message:string,readonly diagnostic:ProviderFailureDiagnostic,readonly reportedUsage?:NormalizedMessage["usage"]) { super(message);this.name="ProviderFailure"; }
}
