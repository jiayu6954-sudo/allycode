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
  getSettings: () => ipcRenderer.invoke("settings:get"),
  getCredentialStatus: () => ipcRenderer.invoke("settings:credential-status"),
  saveSettings: (settings: Partial<AllyCodeSettings>) =>
    ipcRenderer.invoke("settings:save", settings),
  testProvider: (settings: AllyCodeSettings) =>
    ipcRenderer.invoke("settings:test-provider", settings),
  openProviderConsole: (provider: AllyCodeSettings["provider"]) =>
    ipcRenderer.invoke("settings:open-provider-console", provider),
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
  getMemoryOverview: (cwd: string) => ipcRenderer.invoke("memory:get", cwd),
  listTasks: (cwd?: string) => ipcRenderer.invoke("tasks:list", cwd),
  startAgent: (request: AgentStartRequest) => ipcRenderer.invoke("agent:start", request),
  resumeTask: (taskId: string) => ipcRenderer.invoke("agent:resume", taskId),
  abortAgent: (runId: string) => ipcRenderer.invoke("agent:abort", runId),
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
