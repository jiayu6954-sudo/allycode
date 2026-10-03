export interface ToolDefinition {
  name: ToolName;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

export type ToolName =
  | "bash"
  | "file_read"
  | "sources_to_excel"
  | "document_ocr"
  | "document_verify"
  | "document_format"
  | "vision_analyze"
  | "file_write"
  | "file_edit"
  | "glob"
  | "grep"
  | "web_fetch"
  | "web_search"
  | "session_search"
  | "evidence_read"
  | "desktop_control"
  | "plan_update"
  | "phase_checkpoint"
  | "verification_status"
  | "git_commit"
  | "spawn_research"
  | "service_start"
  | "service_status"
  | "service_stop"
  | "browser_verify";

export interface ToolExecutionContext {
  taskId?: string;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** GitHub Personal Access Token — auto-injected into api.github.com requests */
  githubToken?: string;
}

export interface ToolResult {
  content: string;
  isError: boolean;
  metadata?: {
    exitCode?: number;
    truncated?: boolean;
    bytesRead?: number;
    matchCount?: number;
    plan?: PlanUpdateInput;
    serviceName?: string;
    servicePid?: number;
    /** Real-browser verification outcome — read by the completion gate. */
    browserVerified?: boolean;
    pagesChecked?: number;
    evidenceId?: string;
    cwd?: string;
    beforeRevision?: string;
    afterRevision?: string;
    artifact?: { output: string; sha256: string; audit: string; auditSha256: string };
    documentArtifact?: { output: string; sha256: string; sources: Array<{path:string;sha256:string}>; verification: Record<string,unknown>; deliveryFiles?: string[] };
    convertedArtifact?: {output:string;sha256:string;source:string;sourceSha256:string;pages:number};
  };
}

// Typed input shapes for each tool
export interface BashInput {
  command: string;
  timeout?: number;
}

export interface FileReadInput {
  path: string;
  startLine?: number;
  endLine?: number;
}

export interface FileWriteInput {
  path: string;
  content: string;
}

export interface FileEditInput {
  path: string;
  oldString: string;
  newString: string;
}

export interface GlobInput {
  pattern: string;
  path?: string;
}

export interface GrepInput {
  pattern: string;
  path?: string;
  include?: string;
  flags?: string;
}

export interface WebFetchInput {
  url: string;
  maxBytes?: number;
  /** Override the Referer header (useful for APIs that check it, e.g. Sina Finance needs "https://finance.sina.com.cn/") */
  referer?: string;
  /** Additional request headers as key:value pairs */
  headers?: Record<string, string>;
}

export interface WebSearchInput {
  query: string;
  provider?: "auto" | "searxng" | "tavily" | "brave" | "serper" | "duckduckgo";
  maxResults?: number;
}

export interface SessionSearchInput {
  query: string;
  limit?: number;
}

export interface GitCommitInput {
  message: string;
  files?: string[];
}

export interface PlanUpdateInput {
  items: Array<{
    step: string;
    status: "pending" | "in_progress" | "completed";
  }>;
  explanation?: string;
}

export interface SpawnResearchInput {
  query: string;
  depth?: "basic" | "deep";
}

export interface ServiceStartInput {
  /** Stable handle for later status/stop calls, e.g. "api" or "web". */
  name: string;
  command: string;
  /** Health URL polled until it answers below HTTP 500. */
  readyUrl?: string;
  readyTimeoutMs?: number;
  env?: Record<string, string>;
}

export interface ServiceStatusInput {
  name?: string;
  logChars?: number;
}

export interface ServiceStopInput {
  name?: string;
  all?: boolean;
}

export interface BrowserVerifyInput {
  actions?: Array<{ type: "click" | "fill" | "assertText" | "assertVisible"; selector: string; value?: string }>;
  url: string;
  /** Extra routes resolved against `url` — verified in one browser launch. */
  paths?: string[];
  expectText?: string[];
  waitForSelector?: string;
  screenshotPath?: string;
  timeoutMs?: number;
  settleMs?: number;
  viewport?: { width: number; height: number };
}

export type ToolInput =
  | BashInput
  | FileReadInput
  | FileWriteInput
  | FileEditInput
  | GlobInput
  | GrepInput
  | WebFetchInput
  | WebSearchInput
  | SessionSearchInput
  | PlanUpdateInput
  | GitCommitInput
  | SpawnResearchInput
  | ServiceStartInput
  | ServiceStatusInput
  | ServiceStopInput
  | BrowserVerifyInput;
