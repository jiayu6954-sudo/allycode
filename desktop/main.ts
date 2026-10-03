import { workbenchAction } from "./workbench-service.js";
import { AccountClient } from "./account-client.js";
import { setupState, installComponents } from "./setup-service.js";
import type { WorkbenchAction } from "./shared.js";
import { BUILD_INFO } from "../src/build-info.js";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from "electron";
import { getVisionRuntime } from "../src/vision/runtime.js";
import { importVisionFiles } from "./vision-import.js";
import {
  DATA_DIR,
  ensureConfigDir,
  loadSettings,
  replaceSettings,
  saveSettings,
} from "../src/config/settings.js";
import { listSessions, loadSession, assertSessionWorkspace } from "../src/memory/session.js";
import { loadLongTermMemory } from "../src/memory/long-term.js";
import { toDesktopMessages } from "./conversation-view.js";
import { SettingsSchema, type AllyCodeSettings } from "../src/config/schema.js";
import type { PermissionDecision } from "../src/types/permissions.js";
import type {
  AgentStartRequest,
  DeleteSessionsRequest,
  ProviderCredentialStatus,
  WorkspaceEntry,
} from "./shared.js";
import { DesktopAgentService } from "./agent-service.js";
import { testProviderCompatibility } from "../src/providers/diagnostics.js";
import { discoverModelCatalog } from "../src/providers/model-catalog.js";
import { PROVIDER_PRESETS, defaultModelForProvider } from "../src/providers/index.js";
import { renderSessionMarkdown, safeExportFilename } from "./session-export.js";
import {
  CredentialVault,
  extractCredentials,
  hydrateCredentials,
  type CredentialValues,
} from "./credential-vault.js";
import { DesktopUpdateService } from "./update-service.js";
import {
  deleteSkillDocument,
  getSkillsDirectory,
  initDefaultSkills,
  listSkillDocuments,
  saveSkillDocument,
  type SkillDocument,
} from "../src/skills/loader.js";
import { StdioMCPClient } from "../src/mcp/client.js";
import { HttpMCPClient } from "../src/mcp/http-client.js";
import type { MCPServerConfig } from "../src/mcp/types.js";
import type { MCPServerTestResult } from "./shared.js";
import { assertSafeWorkspaceRoot } from "../src/tools/path-guard.js";
import { inspectAgentEngines } from "../src/engines/registry.js";
import { DesktopBenchmarkService } from "./benchmark-service.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
let credentialVault: CredentialVault | null = null;
const agentService = new DesktopAgentService(
  () => mainWindow?.webContents ?? null,
  loadRuntimeSettings,
);
const updateService = new DesktopUpdateService((state) => {
  mainWindow?.webContents.send("updates:state", state);
});

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: "#ffffff",
    title: `AllyCode ${BUILD_INFO.version} · ${BUILD_INFO.sourceHash.slice(0, 12)}`,
    show: false,
    webPreferences: {
      preload: path.join(currentDirectory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.removeMenu();
  mainWindow.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== mainWindow?.webContents.getURL()) event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  // Register visibility before loading. `ready-to-show` can fire before
  // `loadFile()` resolves; registering afterwards leaves a healthy Electron
  // process running forever with its only window still hidden.
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  await mainWindow.loadFile(path.join(currentDirectory, "renderer", "index.html"));
  // Deterministic fallback for renderers/platforms that do not emit the event.
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function registerIpc(): void {
  const account=new AccountClient(requireCredentialVault());
  ipcMain.handle("account:state",()=>account.state());
  ipcMain.handle("account:send",(_event,email:unknown)=>account.send(email));
  ipcMain.handle("account:verify",(_event,email:unknown,code:unknown)=>account.verify(email,code));
  ipcMain.handle("account:logout",()=>account.logout());
  ipcMain.handle("account:delete",()=>account.logout(true));
  ipcMain.handle("setup:state",()=>setupState());
  ipcMain.handle("setup:install",()=>installComponents());
  ipcMain.handle("workbench:action", async (_event, action: WorkbenchAction, cwd: string, id?: string) => {
    if (typeof cwd !== "string" || cwd.length > 4096) throw new Error("项目路径无效");
    if (action === "restore" && agentService.listTasks(cwd).some((task) => task.status === "running" || task.status === "waiting_permission")) throw new Error("请先暂停项目中的运行任务再恢复版本。");
    return workbenchAction(action, cwd, id);
  });
  ipcMain.handle("settings:get", async () => redactSettings(await loadSettings()));
  ipcMain.handle("vision:status", () => getVisionRuntime().status());
  ipcMain.handle("vision:install", () => getVisionRuntime().install());
  ipcMain.handle("vision:cancel", () => getVisionRuntime().cancel());
  ipcMain.handle("vision:import",async(_event,cwd:string)=>{
    assertSafeWorkspaceRoot(cwd);
    const result=await dialog.showOpenDialog(mainWindow!,{title:"添加图片或 PDF（复制到当前项目）",properties:["openFile","multiSelections"],filters:[{name:"图片和 PDF",extensions:["png","jpg","jpeg","bmp","tif","tiff","pdf"]}]});
    return result.canceled?[]:importVisionFiles(cwd,result.filePaths);
  });
  ipcMain.handle("settings:credential-status", async () =>
    getCredentialStatus()
  );
  ipcMain.handle(
    "settings:save",
    async (_event, partial: Partial<AllyCodeSettings>) => {
      const { publicSettings, credentials } = extractCredentials(partial);
      if (publicSettings.mcpServers) {
        publicSettings.mcpServers = preserveMcpSecrets(
          publicSettings.mcpServers,
          (await loadSettings()).mcpServers,
        );
      }
      await requireCredentialVault().setMany(credentials);
      await saveSettings(publicSettings);
      return redactSettings(await loadSettings());
    },
  );
  ipcMain.handle(
    "settings:open-provider-console",
    async (_event, provider: AllyCodeSettings["provider"]) => {
      const url = PROVIDER_CONSOLE_URLS[provider];
      if (!url) throw new Error("该供应商没有可用的官方密钥申请页面。");
      await shell.openExternal(url);
    },
  );
  ipcMain.handle("updates:get-state", () => updateService.getState());
  ipcMain.handle("updates:check", () => updateService.check());
  ipcMain.handle("updates:download", () => updateService.download());
  ipcMain.handle("updates:install", () => updateService.install());
  ipcMain.handle("skills:list", () => listSkillDocuments());
  ipcMain.handle("skills:save", (_event, skill: SkillDocument) => {
    saveSkillDocument(skill);
    return listSkillDocuments();
  });
  ipcMain.handle("skills:delete", (_event, id: string) => {
    deleteSkillDocument(id);
    return listSkillDocuments();
  });
  ipcMain.handle("skills:open-folder", async () => {
    initDefaultSkills();
    const error = await shell.openPath(getSkillsDirectory());
    if (error) throw new Error(error);
  });
  ipcMain.handle("mcp:test", async (_event, input: unknown) => {
    const servers = preserveMcpSecrets(
      SettingsSchema.shape.mcpServers.parse(input),
      (await loadSettings()).mcpServers,
    );
    return Promise.all(servers.map(testMcpServer));
  });
  ipcMain.handle(
    "settings:test-provider",
    async (_event, draft: AllyCodeSettings) => {
      const { publicSettings, credentials } = extractCredentials(draft);
      const storedCredentials = await requireCredentialVault().getAll();
      const candidate = hydrateCredentials(publicSettings, {
        ...storedCredentials,
        ...removeEmptyCredentials(credentials),
      });
      return testProviderCompatibility(candidate);
    },
  );
  ipcMain.handle(
    "settings:list-models",
    async (_event, draft: AllyCodeSettings) => {
      const { publicSettings, credentials } = extractCredentials(draft);
      const storedCredentials = await requireCredentialVault().getAll();
      const candidate = hydrateCredentials(publicSettings, {
        ...storedCredentials,
        ...removeEmptyCredentials(credentials),
      });
      return discoverModelCatalog({
        provider: candidate.provider,
        baseUrl: providerCatalogBaseUrl(candidate),
        apiKey: providerCatalogCredential(candidate),
        selectedModel: candidate.model,
        fallbackModelIds: [defaultModelForProvider(candidate.provider)],
        protocol: resolvedCatalogProtocol(candidate),
        style: candidate.provider === "anthropic"
          ? "anthropic"
          : candidate.provider === "ollama"
            ? "ollama"
            : "openai",
      });
    },
  );
  ipcMain.handle("workspace:choose", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ["openDirectory"],
      title: "选择 AllyCode 项目文件夹",
    });
    const selected = result.canceled ? null : result.filePaths[0] ?? null;
    if (selected) assertSafeWorkspaceRoot(selected);
    return selected;
  });
  ipcMain.handle("workspace:list", async (_event, cwd: string) =>
    listDirectory(path.resolve(cwd), path.resolve(cwd), 0)
  );
  ipcMain.handle("sessions:list", async () =>
    (await listSessions()).map((session) => ({
      id: session.id,
      title: session.title ?? "未命名会话",
      updatedAt: session.updatedAt,
      cwd: session.cwd,
      model: session.model,
    }))
  );
  ipcMain.handle("sessions:load", async (_event, id: string) => {
    const session = await loadSession(id);
    if(!session) return [];
    return [...toDesktopMessages(session.messages),...agentService.sessionReceipts(id).map(receipt=>({id:`receipt-${receipt.runId}`,role:"system" as const,content:[{type:"text" as const,text:receipt.rendered}],timestamp:receipt.generatedAt}))];
  });
  ipcMain.handle("sessions:export", async (_event, id: string) => {
    const session = await loadSession(id);
    if (!session) throw new Error("找不到要导出的会话。");
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: "导出 AllyCode 会话",
      defaultPath: path.join(
        app.getPath("documents"),
        `${safeExportFilename(session.title ?? "AllyCode 会话")}.md`,
      ),
      filters: [
        { name: "Markdown 文档", extensions: ["md"] },
        { name: "文本文件", extensions: ["txt"] },
      ],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    await fs.writeFile(result.filePath, renderSessionMarkdown(session), "utf8");
    return { canceled: false, filePath: result.filePath };
  });
  ipcMain.handle(
    "sessions:delete",
    (_event, request: DeleteSessionsRequest) => agentService.deleteSessions(request),
  );
  ipcMain.handle("tasks:list", (_event, cwd?: string) => agentService.listTasks(cwd));
  ipcMain.handle("monitor:get", (_event, taskId: string) => {
    const report = agentService.getMonitorReport(taskId);
    return {
      report,
      nextAfterId: report.timeline.at(-1)?.id ?? 0,
    };
  });
  ipcMain.handle("monitor:export", async (_event, taskId: string) => {
    const report = agentService.getDiagnosticExport(taskId);
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: "导出 AllyCode Agent 脱敏诊断报告",
      defaultPath: path.join(
        app.getPath("documents"),
        `AllyCode-Diagnostic-${report.task.id.slice(0, 8)}.json`,
      ),
      filters: [{ name: "JSON 诊断报告", extensions: ["json"] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    await fs.writeFile(result.filePath, JSON.stringify(report, null, 2), "utf8");
    return { canceled: false, filePath: result.filePath };
  });
  ipcMain.handle("memory:get", async (_event, cwd: string, sessionId?: string) => {
    const session = sessionId ? await loadSession(sessionId) : null;
    if (session) assertSessionWorkspace(session, cwd);
    const memory = session ? await loadLongTermMemory(cwd, session.id) : {user:"",projectContext:"",projectDecisions:"",projectLearnings:""};
    const tasks = agentService.listTasks(cwd);
    return {
      ...memory,
      taskCount: tasks.length,
      resumableTaskCount: tasks.filter((task) => task.resumable).length,
    };
  });
  ipcMain.handle("engines:inspect", async () =>
    inspectAgentEngines(await loadSettings())
  );
  ipcMain.handle("benchmark:get", (_event, workspace?: string) =>
    benchmarkService().state(workspace)
  );
  ipcMain.handle("benchmark:prepare", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ["openDirectory", "createDirectory"],
      title: "选择评测项目的保存位置",
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const workspace = await benchmarkService().prepare(result.filePaths[0]);
    return { canceled: false, workspace };
  });
  ipcMain.handle("benchmark:run", (_event, workspace: string) =>
    benchmarkService().run(workspace)
  );
  ipcMain.handle("agent:start", (_event, request: AgentStartRequest) =>
    agentService.start(request)
  );
  ipcMain.handle("agent:resume", (_event, taskId: string) =>
    agentService.resumeTask(taskId)
  );
  ipcMain.handle("agent:continue-phase",(_event,taskId:string,toolId:string,optionId?:string)=>agentService.continuePhase(taskId,toolId,optionId));
  ipcMain.handle("agent:abort", (_event, runId: string) => {
    agentService.abort(runId);
  });
  ipcMain.handle("agent:steer",(_event,runId:string,text:string)=>agentService.steer(runId,text));
  ipcMain.handle(
    "agent:permission",
    (_event, requestId: string, decision: PermissionDecision) => {
      agentService.resolvePermission(requestId, decision);
    },
  );
}

function benchmarkService(): DesktopBenchmarkService {
  const root = app.isPackaged
    ? path.join(process.resourcesPath, "benchmarks")
    : path.join(app.getAppPath(), "benchmarks");
  return new DesktopBenchmarkService(root, process.execPath);
}

async function testMcpServer(config: MCPServerConfig): Promise<MCPServerTestResult> {
  const startedAt = Date.now();
  const client = config.transport === "http"
    ? new HttpMCPClient(config)
    : new StdioMCPClient(config);
  try {
    await client.connect();
    const tools = await client.listTools();
    return {
      name: config.name,
      ok: true,
      toolCount: tools.length,
      tools: tools.map((tool) => tool.name).sort(),
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      name: config.name,
      ok: false,
      toolCount: 0,
      tools: [],
      latencyMs: Date.now() - startedAt,
      error: redactMcpSecrets(error instanceof Error ? error.message : String(error), config),
    };
  } finally {
    await client.disconnect().catch(() => undefined);
  }
}

function redactMcpSecrets(message: string, config: MCPServerConfig): string {
  let safe = message;
  for (const value of Object.values(config.env ?? {})) {
    if (value.length >= 4) safe = safe.split(value).join("[REDACTED]");
  }
  return safe;
}

const PROVIDER_CONSOLE_URLS: Partial<Record<AllyCodeSettings["provider"], string>> = {
  deepseek: "https://platform.deepseek.com/api_keys",
  qwen: "https://bailian.console.aliyun.com/?apiKey=1",
  moonshot: "https://platform.moonshot.cn/console/api-keys",
  anthropic: "https://console.anthropic.com/settings/keys",
  openai: "https://platform.openai.com/api-keys",
  groq: "https://console.groq.com/keys",
  gemini: "https://aistudio.google.com/app/apikey",
  openrouter: "https://openrouter.ai/settings/keys",
};

async function getCredentialStatus(): Promise<ProviderCredentialStatus> {
  const credentials = await requireCredentialVault().getAll();
  const settings = await loadSettings();
  return {
    anthropic: Boolean(credentials.anthropic || process.env["ANTHROPIC_API_KEY"]),
    openai: Boolean(credentials.openai || process.env["OPENAI_API_KEY"]),
    deepseek: Boolean(credentials.deepseek || process.env["DEEPSEEK_API_KEY"]),
    qwen: Boolean(credentials.qwen || process.env["DASHSCOPE_API_KEY"]),
    groq: Boolean(credentials.groq || process.env["GROQ_API_KEY"]),
    gemini: Boolean(credentials.gemini || process.env["GEMINI_API_KEY"]),
    openrouter: Boolean(
      credentials.openrouter || process.env["OPENROUTER_API_KEY"]
    ),
    moonshot: Boolean(credentials.moonshot || process.env["MOONSHOT_API_KEY"]),
    ollama: true,
    custom: Boolean(credentials.custom || settings.customProviderUrl),
  };
}

function redactSettings(settings: AllyCodeSettings): AllyCodeSettings {
  const publicSettings = extractCredentials(settings).publicSettings;
  publicSettings.mcpServers = publicSettings.mcpServers.map(({ env: _env, ...server }) => server);
  return publicSettings;
}

function preserveMcpSecrets(
  publicServers: AllyCodeSettings["mcpServers"],
  storedServers: AllyCodeSettings["mcpServers"],
): AllyCodeSettings["mcpServers"] {
  return publicServers.map((server) => {
    const stored = storedServers.find((candidate) =>
      candidate.name === server.name && candidate.transport === server.transport
    );
    return { ...server, ...(stored?.env ? { env: stored.env } : {}) };
  });
}

async function loadRuntimeSettings(): Promise<AllyCodeSettings> {
  const settings = await loadSettings();
  return hydrateCredentials(settings, await requireCredentialVault().getAll());
}

function requireCredentialVault(): CredentialVault {
  if (!credentialVault) throw new Error("安全密钥库尚未初始化。");
  return credentialVault;
}

function removeEmptyCredentials(values: CredentialValues): CredentialValues {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => Boolean(value)),
  ) as CredentialValues;
}

function providerCatalogCredential(settings: AllyCodeSettings): string | undefined {
  const credentials: Partial<Record<AllyCodeSettings["provider"], string | undefined>> = {
    anthropic: settings.apiKey,
    openai: settings.openaiApiKey,
    deepseek: settings.deepseekApiKey,
    qwen: settings.qwenApiKey,
    groq: settings.groqApiKey,
    gemini: settings.geminiApiKey,
    openrouter: settings.openrouterApiKey,
    moonshot: settings.moonshotApiKey,
    custom: settings.customProviderKey,
  };
  return credentials[settings.provider];
}

function providerCatalogBaseUrl(settings: AllyCodeSettings): string | undefined {
  if (settings.provider === "custom") return settings.customProviderUrl;
  if (settings.provider === "ollama") {
    return settings.providerBaseUrls.ollama
      ?? settings.localModel.serviceUrl
      ?? settings.customProviderUrl;
  }
  return settings.providerBaseUrls[settings.provider]
    ?? PROVIDER_PRESETS[settings.provider]?.baseUrl;
}

function resolvedCatalogProtocol(
  settings: AllyCodeSettings,
): "anthropic" | "chat_completions" | "responses" {
  if (settings.providerProtocol !== "auto") return settings.providerProtocol;
  if (settings.provider === "anthropic") return "anthropic";
  return settings.provider === "openai" ? "responses" : "chat_completions";
}

async function initializeCredentialVault(): Promise<void> {
  credentialVault = new CredentialVault(
    path.join(DATA_DIR, "credentials.secure.json"),
    {
      isAvailable: async () => await safeStorage.isAsyncEncryptionAvailable() && !(process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text"),
      encrypt: (value) => safeStorage.encryptStringAsync(value),
      decrypt: async (value) => {
        const decrypted = await safeStorage.decryptStringAsync(value);
        return { value: decrypted.result, shouldReEncrypt: decrypted.shouldReEncrypt };
      },
      backend: () => process.platform === "win32"
        ? "windows-dpapi"
        : process.platform === "darwin"
          ? "macos-keychain"
          : safeStorage.getSelectedStorageBackend(),
    },
  );
  try { await credentialVault.initialize(); }
  catch { console.warn("系统安全密钥库未就绪：允许打开设置，保存密钥与账号登录将被阻止。请启用系统密钥库后重启。"); return; }

  // One-time migration: encrypt first, and only then remove secrets from settings.json.
  const legacySettings = await loadSettings();
  const { publicSettings, credentials } = extractCredentials(legacySettings);
  if (Object.values(credentials).some(Boolean)) {
    await credentialVault.setMany(credentials);
    publicSettings.onboarding = {
      ...publicSettings.onboarding,
      completed: true,
      completedAt: publicSettings.onboarding.completedAt ?? new Date().toISOString(),
    };
    await replaceSettings(publicSettings);
  }
}

async function listDirectory(
  root: string,
  directory: string,
  depth: number,
): Promise<WorkspaceEntry[]> {
  const relative = path.relative(root, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("项目路径超出了已选择的项目根目录。");
  }
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const visible = entries
    .filter((entry) => ![".git", "node_modules", "dist", "dist-desktop", "release"].includes(entry.name))
    .sort((a, b) =>
      Number(b.isDirectory()) - Number(a.isDirectory()) ||
      a.name.localeCompare(b.name)
    )
    .slice(0, 150);
  return Promise.all(visible.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    const item: WorkspaceEntry = {
      name: entry.name,
      path: path.relative(root, entryPath),
      type: entry.isDirectory() ? "directory" : "file",
    };
    if (entry.isDirectory() && depth < 1) {
      item.children = await listDirectory(root, entryPath, depth + 1).catch(() => []);
    }
    return item;
  }));
}

app.whenReady().then(async () => {
  await ensureConfigDir();
  initDefaultSkills();
  await initializeCredentialVault();
  registerIpc();
  await createWindow();
  const settings = await loadSettings();
  await updateService.initialize(settings);
  if (settings.updates.enabled) {
    setTimeout(() => void updateService.check(), 10_000);
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

let visionQuitReady=false;
app.on("before-quit",event=>{if(visionQuitReady)return;event.preventDefault();getVisionRuntime().cancel();void getVisionRuntime().stop().finally(()=>{visionQuitReady=true;app.quit();});});
