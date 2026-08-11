import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from "electron";
import {
  DATA_DIR,
  ensureConfigDir,
  loadSettings,
  replaceSettings,
  saveSettings,
} from "../src/config/settings.js";
import { listSessions, loadSession } from "../src/memory/session.js";
import { loadLongTermMemory } from "../src/memory/long-term.js";
import type { ConversationMessage, UIContentBlock } from "../src/types/agent.js";
import type { AllyCodeSettings } from "../src/config/schema.js";
import type { PermissionDecision } from "../src/types/permissions.js";
import type {
  AgentStartRequest,
  DeleteSessionsRequest,
  DesktopMessage,
  ProviderCredentialStatus,
  WorkspaceEntry,
} from "./shared.js";
import { DesktopAgentService } from "./agent-service.js";
import { testProviderCompatibility } from "../src/providers/diagnostics.js";
import { renderSessionMarkdown, safeExportFilename } from "./session-export.js";
import {
  CredentialVault,
  extractCredentials,
  hydrateCredentials,
  type CredentialValues,
} from "./credential-vault.js";
import { DesktopUpdateService } from "./update-service.js";

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
    title: "AllyCode",
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
  await mainWindow.loadFile(path.join(currentDirectory, "renderer", "index.html"));
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function registerIpc(): void {
  ipcMain.handle("settings:get", async () => redactSettings(await loadSettings()));
  ipcMain.handle("settings:credential-status", async () =>
    getCredentialStatus()
  );
  ipcMain.handle(
    "settings:save",
    async (_event, partial: Partial<AllyCodeSettings>) => {
      const { publicSettings, credentials } = extractCredentials(partial);
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
  ipcMain.handle("workspace:choose", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ["openDirectory"],
      title: "选择 AllyCode 项目文件夹",
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
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
    return session ? toDesktopMessages(session.messages) : [];
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
  ipcMain.handle("memory:get", async (_event, cwd: string) => {
    const memory = await loadLongTermMemory(cwd);
    const tasks = agentService.listTasks(cwd);
    return {
      ...memory,
      taskCount: tasks.length,
      resumableTaskCount: tasks.filter((task) => task.resumable).length,
    };
  });
  ipcMain.handle("agent:start", (_event, request: AgentStartRequest) =>
    agentService.start(request)
  );
  ipcMain.handle("agent:resume", (_event, taskId: string) =>
    agentService.resumeTask(taskId)
  );
  ipcMain.handle("agent:abort", (_event, runId: string) => {
    agentService.abort(runId);
  });
  ipcMain.handle(
    "agent:permission",
    (_event, requestId: string, decision: PermissionDecision) => {
      agentService.resolvePermission(requestId, decision);
    },
  );
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
  return extractCredentials(settings).publicSettings;
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

async function initializeCredentialVault(): Promise<void> {
  credentialVault = new CredentialVault(
    path.join(DATA_DIR, "credentials.secure.json"),
    {
      isAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
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
  await credentialVault.initialize();

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

function toDesktopMessages(messages: ConversationMessage[]): DesktopMessage[] {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message, index) => ({
      id: `saved-${index}`,
      role: message.role,
      content: normalizeContent(message.content),
      timestamp: new Date().toISOString(),
    }));
}

function normalizeContent(content: ConversationMessage["content"]): UIContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  const normalized: UIContentBlock[] = [];
  for (const block of content) {
    if (block.type === "text") {
      normalized.push({ type: "text", text: block.text });
    }
    if (block.type === "tool_use") {
      normalized.push({
        type: "tool_use",
        toolName: block.name,
        toolId: block.id,
        input: block.input,
        status: "success",
      });
    }
    if (block.type === "tool_result") {
      const resultText = typeof block.content === "string"
        ? block.content
        : (block.content ?? []).map((item) =>
          item.type === "text" ? item.text : "[content]"
        ).join("\n");
      normalized.push({
        type: "tool_result",
        toolId: block.tool_use_id,
        content: resultText,
        isError: Boolean(block.is_error),
      });
    }
  }
  return normalized;
}

app.whenReady().then(async () => {
  await ensureConfigDir();
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
