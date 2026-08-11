import type { AgentEvent, UIContentBlock } from "../src/types/agent.js";
import type { AllyCodeSettings } from "../src/config/schema.js";
import type { PermissionDecision, PermissionRequest } from "../src/types/permissions.js";
import type { TaskStatus } from "../src/storage/agent-database.js";
import type { ProviderTestResult } from "../src/providers/diagnostics.js";

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: string;
  cwd: string;
  model: string;
}

export interface DeleteSessionsRequest {
  sessionIds: string[];
  includeDurableTasks: boolean;
}

export interface DeleteSessionsResult {
  deletedSessionCount: number;
  detachedTaskCount: number;
  deletedTaskCount: number;
  deletedEventCount: number;
}

export interface ExportSessionResult {
  canceled: boolean;
  filePath?: string;
}

export interface WorkspaceEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: WorkspaceEntry[];
}

export interface DesktopMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: UIContentBlock[];
  timestamp: string;
  streaming?: boolean;
}

export interface AgentStartRequest {
  prompt: string;
  cwd: string;
  sessionId?: string;
  taskId?: string;
  resume?: boolean;
}

export interface TaskSummary {
  id: string;
  projectId: string;
  sessionId?: string;
  title: string;
  goal: string;
  status: TaskStatus;
  cwd: string;
  updatedAt: string;
  createdAt: string;
  lastError?: string;
  resumable: boolean;
}

export interface MemoryOverview {
  user: string;
  projectContext: string;
  projectDecisions: string;
  projectLearnings: string;
  taskCount: number;
  resumableTaskCount: number;
}

export type ProviderCredentialStatus = Record<
  AllyCodeSettings["provider"],
  boolean
>;

export interface UpdateState {
  status: "disabled" | "idle" | "checking" | "available" | "downloading" | "downloaded" | "up-to-date" | "error";
  currentVersion: string;
  availableVersion?: string;
  progress?: number;
  source?: string;
  message?: string;
}

export type DesktopAgentEvent =
  | { runId: string; event: AgentEvent }
  | { runId: string; type: "permission"; requestId: string; request: PermissionRequest }
  | { runId: string; type: "task_status"; task: TaskSummary }
  | { runId: string; type: "complete"; sessionId: string; taskId: string }
  | { runId: string; type: "paused"; sessionId: string; taskId: string }
  | { runId: string; type: "fatal"; taskId?: string; message: string };

export interface AllyCodeDesktopApi {
  getSettings(): Promise<AllyCodeSettings>;
  getCredentialStatus(): Promise<ProviderCredentialStatus>;
  saveSettings(settings: Partial<AllyCodeSettings>): Promise<AllyCodeSettings>;
  testProvider(settings: AllyCodeSettings): Promise<ProviderTestResult>;
  openProviderConsole(provider: AllyCodeSettings["provider"]): Promise<void>;
  getUpdateState(): Promise<UpdateState>;
  checkForUpdates(): Promise<UpdateState>;
  downloadUpdate(): Promise<UpdateState>;
  installUpdate(): Promise<void>;
  onUpdateState(listener: (state: UpdateState) => void): () => void;
  chooseWorkspace(): Promise<string | null>;
  listWorkspace(cwd: string): Promise<WorkspaceEntry[]>;
  listSessions(): Promise<SessionSummary[]>;
  loadSession(id: string): Promise<DesktopMessage[]>;
  exportSession(id: string): Promise<ExportSessionResult>;
  deleteSessions(request: DeleteSessionsRequest): Promise<DeleteSessionsResult>;
  getMemoryOverview(cwd: string): Promise<MemoryOverview>;
  listTasks(cwd?: string): Promise<TaskSummary[]>;
  startAgent(request: AgentStartRequest): Promise<{ runId: string; taskId: string }>;
  resumeTask(taskId: string): Promise<{ runId: string; taskId: string }>;
  abortAgent(runId: string): Promise<void>;
  resolvePermission(
    requestId: string,
    decision: PermissionDecision,
  ): Promise<void>;
  onAgentEvent(listener: (event: DesktopAgentEvent) => void): () => void;
  platform: string;
}
