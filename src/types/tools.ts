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
  | "file_write"
  | "file_edit"
  | "glob"
  | "grep"
  | "web_fetch"
  | "web_search"
  | "session_search"
  | "git_commit"
  | "spawn_research";

export interface ToolExecutionContext {
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

export interface SpawnResearchInput {
  query: string;
  depth?: "basic" | "deep";
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
  | GitCommitInput
  | SpawnResearchInput;
