import { contextBridge, ipcRenderer } from "electron";
import type {
  AgentStartRequest,
  AllyCodeDesktopApi,
  DeleteSessionsRequest,
  DesktopAgentEvent,
} from "./shared.js";
import type { AllyCodeSettings } from "../src/config/schema.js";
import type { PermissionDecision } from "../src/types/permissions.js";

const api: AllyCodeDesktopApi = {
  accountState: () => ipcRenderer.invoke("account:state"),
  accountSend: (email) => ipcRenderer.invoke("account:send",email),
  accountVerify: (email,code) => ipcRenderer.invoke("account:verify",email,code),
  accountLogout: () => ipcRenderer.invoke("account:logout"),
  accountDelete: () => ipcRenderer.invoke("account:delete"),
  setupState: () => ipcRenderer.invoke("setup:state"),
  installComponents: () => ipcRenderer.invoke("setup:install"),
  visionStatus: () => ipcRenderer.invoke("vision:status"),
  visionInstall: () => ipcRenderer.invoke("vision:install"),
  visionCancel: () => ipcRenderer.invoke("vision:cancel"),
  importVisionFiles: (cwd) => ipcRenderer.invoke("vision:import",cwd),
  workbenchAction: (action, cwd, id) => ipcRenderer.invoke("workbench:action", action, cwd, id),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  getCredentialStatus: () => ipcRenderer.invoke("settings:credential-status"),
  saveSettings: (settings: Partial<AllyCodeSettings>) =>
    ipcRenderer.invoke("settings:save", settings),
  testProvider: (settings: AllyCodeSettings) =>
    ipcRenderer.invoke("settings:test-provider", settings),
  listProviderModels: (settings: AllyCodeSettings) =>
    ipcRenderer.invoke("settings:list-models", settings),
  openProviderConsole: (provider: AllyCodeSettings["provider"]) =>
    ipcRenderer.invoke("settings:open-provider-console", provider),
  listSkills: () => ipcRenderer.invoke("skills:list"),
  saveSkill: (skill) => ipcRenderer.invoke("skills:save", skill),
  deleteSkill: (id) => ipcRenderer.invoke("skills:delete", id),
  openSkillsFolder: () => ipcRenderer.invoke("skills:open-folder"),
  testMcpServers: (servers) => ipcRenderer.invoke("mcp:test", servers),
  getUpdateState: () => ipcRenderer.invoke("updates:get-state"),
  checkForUpdates: () => ipcRenderer.invoke("updates:check"),
  downloadUpdate: () => ipcRenderer.invoke("updates:download"),
  installUpdate: () => ipcRenderer.invoke("updates:install"),
  onUpdateState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]) =>
      listener(state);
    ipcRenderer.on("updates:state", handler);
    return () => ipcRenderer.removeListener("updates:state", handler);
  },
  chooseWorkspace: () => ipcRenderer.invoke("workspace:choose"),
  listWorkspace: (cwd: string) => ipcRenderer.invoke("workspace:list", cwd),
  listSessions: () => ipcRenderer.invoke("sessions:list"),
  loadSession: (id: string) => ipcRenderer.invoke("sessions:load", id),
  exportSession: (id: string) => ipcRenderer.invoke("sessions:export", id),
  deleteSessions: (request: DeleteSessionsRequest) =>
    ipcRenderer.invoke("sessions:delete", request),
  getMemoryOverview: (cwd: string, sessionId?: string) => ipcRenderer.invoke("memory:get", cwd, sessionId),
  inspectAgentEngines: () => ipcRenderer.invoke("engines:inspect"),
  listTasks: (cwd?: string) => ipcRenderer.invoke("tasks:list", cwd),
  getMonitorReport: (taskId: string) => ipcRenderer.invoke("monitor:get", taskId),
  exportMonitorReport: (taskId: string) => ipcRenderer.invoke("monitor:export", taskId),
  getBenchmarkLab: (workspace?: string) => ipcRenderer.invoke("benchmark:get", workspace),
  prepareBenchmarkWorkspace: () => ipcRenderer.invoke("benchmark:prepare"),
  runBenchmark: (workspace: string) => ipcRenderer.invoke("benchmark:run", workspace),
  startAgent: (request: AgentStartRequest) => ipcRenderer.invoke("agent:start", request),
  resumeTask: (taskId: string) => ipcRenderer.invoke("agent:resume", taskId),
  continuePhase: (taskId,toolId,optionId) => ipcRenderer.invoke("agent:continue-phase",taskId,toolId,optionId),
  abortAgent: (runId: string) => ipcRenderer.invoke("agent:abort", runId),
  steerAgent: (runId: string, text: string) => ipcRenderer.invoke("agent:steer",runId,text),
  resolvePermission: (requestId: string, decision: PermissionDecision) =>
    ipcRenderer.invoke("agent:permission", requestId, decision),
  onAgentEvent: (listener: (event: DesktopAgentEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: DesktopAgentEvent) =>
      listener(payload);
    ipcRenderer.on("agent:event", handler);
    return () => ipcRenderer.removeListener("agent:event", handler);
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld("allycode", api);
