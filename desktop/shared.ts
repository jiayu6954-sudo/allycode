import type { AgentEvent, UIContentBlock } from "../src/types/agent.js";
import type { PlanUpdateInput } from "../src/types/tools.js";
import type { AllyCodeSettings } from "../src/config/schema.js";
import type { PermissionDecision, PermissionRequest } from "../src/types/permissions.js";
import type { TaskStatus } from "../src/storage/agent-database.js";
import type { ProviderTestResult } from "../src/providers/diagnostics.js";
import type { ModelCatalogResult } from "../src/providers/model-catalog.js";
import type { SkillDocument } from "../src/skills/loader.js";
import type { AgentMonitorReport } from "../src/observability/agent-monitor.js";
import type { ExecutionReceipt } from "../src/observability/execution-receipt.js";
import type { AgentEngineHealth } from "../src/engines/types.js";

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

export type DesktopContentBlock = UIContentBlock | {
  type: "plan";
  items: PlanUpdateInput["items"];
};

export interface DesktopMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: DesktopContentBlock[];
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
  plan?: PlanUpdateInput["items"];
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

export interface MCPServerTestResult {
  name: string;
  ok: boolean;
  toolCount: number;
  tools: string[];
  latencyMs: number;
  error?: string;
}

export interface MonitorSnapshot {
  report: AgentMonitorReport;
  nextAfterId: number;
}

export interface ExportMonitorResult {
  canceled: boolean;
  filePath?: string;
}

export interface BenchmarkCheckResult {
  id: string;
  section: string;
  points: number;
  earned: number;
  passed: boolean;
  detail: string;
}

export interface BenchmarkRunReport {
  challenge: string;
  generatedAt: string;
  score: number;
  total: number;
  results: BenchmarkCheckResult[];
  boundary: string;
}

export interface BenchmarkLabState {
  id: string;
  title: string;
  description: string;
  preparedWorkspace?: string;
  latest?: BenchmarkRunReport;
  principles: string[];
}

export type DesktopAgentEvent =
  | { runId: string; event: AgentEvent }
  | { runId: string; type: "permission"; requestId: string; request: PermissionRequest }
  | { runId: string; type: "task_status"; task: TaskSummary }
  | { runId: string; type: "complete"; sessionId: string; taskId: string }
  | {
      runId: string;
      type: "paused";
      sessionId: string;
      taskId: string;
      reason?: "user" | "checkpoint" | "run_budget";
      message?: string;
    }
  | {
      runId: string;
      type: "delivery_receipt";
      taskId: string;
      receipt: ExecutionReceipt;
      /** Pre-rendered plain-language text for readers who are not engineers. */
      rendered: string;
    }
  | { runId: string; type: "fatal"; taskId?: string; message: string };

export interface AllyCodeDesktopApi {
  accountState(): Promise<import("./account-client.js").AccountState>;
  accountSend(email:string): Promise<void>;
  accountVerify(email:string,code:string): Promise<import("./account-client.js").AccountState>;
  accountLogout(): Promise<import("./account-client.js").AccountState>;
  accountDelete(): Promise<import("./account-client.js").AccountState>;
  setupState(): Promise<import("./setup-service.js").SetupState>;
  installComponents(): Promise<import("./setup-service.js").SetupState>;
  visionStatus(): Promise<import("../src/vision/runtime.js").VisionState>;
  visionInstall(): Promise<import("../src/vision/runtime.js").VisionState>;
  visionCancel(): Promise<void>;
  importVisionFiles(cwd:string): Promise<string[]>;
  workbenchAction(action: WorkbenchAction, cwd: string, id?: string): Promise<WorkbenchResult>;
  getSettings(): Promise<AllyCodeSettings>;
  getCredentialStatus(): Promise<ProviderCredentialStatus>;
  saveSettings(settings: Partial<AllyCodeSettings>): Promise<AllyCodeSettings>;
  testProvider(settings: AllyCodeSettings): Promise<ProviderTestResult>;
  listProviderModels(settings: AllyCodeSettings): Promise<ModelCatalogResult>;
  openProviderConsole(provider: AllyCodeSettings["provider"]): Promise<void>;
  listSkills(): Promise<SkillDocument[]>;
  saveSkill(skill: SkillDocument): Promise<SkillDocument[]>;
  deleteSkill(id: string): Promise<SkillDocument[]>;
  openSkillsFolder(): Promise<void>;
  testMcpServers(servers: AllyCodeSettings["mcpServers"]): Promise<MCPServerTestResult[]>;
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
  getMemoryOverview(cwd: string, sessionId?: string): Promise<MemoryOverview>;
  inspectAgentEngines(): Promise<AgentEngineHealth[]>;
  listTasks(cwd?: string): Promise<TaskSummary[]>;
  getMonitorReport(taskId: string): Promise<MonitorSnapshot>;
  exportMonitorReport(taskId: string): Promise<ExportMonitorResult>;
  getBenchmarkLab(workspace?: string): Promise<BenchmarkLabState>;
  prepareBenchmarkWorkspace(): Promise<{ canceled: boolean; workspace?: string }>;
  runBenchmark(workspace: string): Promise<BenchmarkRunReport>;
  startAgent(request: AgentStartRequest): Promise<{ runId: string; taskId: string }>;
  resumeTask(taskId: string): Promise<{ runId: string; taskId: string }>;
  continuePhase(taskId:string,toolId:string,optionId?:string):Promise<{runId:string;taskId:string}>;
  abortAgent(runId: string): Promise<void>;
  steerAgent(runId: string, text: string): Promise<{id:string;status:"queued"}>;
  resolvePermission(
    requestId: string,
    decision: PermissionDecision,
  ): Promise<void>;
  onAgentEvent(listener: (event: DesktopAgentEvent) => void): () => void;
  platform: string;
}

export type WorkbenchAction = "inspect" | "open-project" | "snapshot" | "restore" | "import-skill" | "import-mcp" | "install-codex";
export interface WorkbenchResult { message: string; snapshots?: Array<{id: string; label: string; createdAt: string}>; }
