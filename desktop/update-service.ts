import fs from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import updaterPackage from "electron-updater";
import type { AllyCodeSettings } from "../src/config/schema.js";
import type { UpdateState } from "./shared.js";
import { normalizeSources } from "./update-sources.js";

interface UpdateSourcesDocument {
  schemaVersion: 1;
  channels: Partial<Record<"stable" | "alpha", string[]>>;
}

const { autoUpdater } = updaterPackage;

export class DesktopUpdateService {
  private state: UpdateState = {
    status: app.isPackaged ? "idle" : "disabled",
    currentVersion: app.getVersion(),
    message: app.isPackaged ? undefined : "开发模式不执行自动更新。",
  };
  private sources: string[] = [];
  private sourceIndex = 0;
  private configured = false;

  constructor(private readonly publish: (state: UpdateState) => void) {}

  async initialize(settings: AllyCodeSettings): Promise<void> {
    this.sources = await loadUpdateSources(settings.updates.channel);
    autoUpdater.autoDownload = settings.updates.automaticDownload;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = settings.updates.channel === "alpha";
    autoUpdater.channel = settings.updates.channel;
    this.bindEvents();
    this.configured = true;

    if (!app.isPackaged || !settings.updates.enabled) {
      this.setState({
        status: "disabled",
        message: !settings.updates.enabled ? "自动更新已关闭。" : "开发模式不执行自动更新。",
      });
    } else if (this.sources.length === 0) {
      this.setState({ status: "disabled", message: "当前安装包未配置国内更新源。" });
    }
  }

  getState(): UpdateState {
    return { ...this.state };
  }

  async check(): Promise<UpdateState> {
    if (!this.configured) throw new Error("更新服务尚未初始化。");
    if (!app.isPackaged) return this.getState();
    if (this.sources.length === 0) {
      this.setState({ status: "disabled", message: "当前安装包未配置国内更新源。" });
      return this.getState();
    }

    this.setState({ status: "checking", message: "正在检查国内更新源…", progress: undefined });
    let lastError: unknown;
    for (let index = 0; index < this.sources.length; index += 1) {
      this.sourceIndex = index;
      const source = this.sources[index]!;
      try {
        autoUpdater.setFeedURL({ provider: "generic", url: source, channel: autoUpdater.channel });
        this.setState({ source, message: index === 0 ? "正在连接主更新源…" : "主源不可用，正在连接备用源…" });
        await autoUpdater.checkForUpdates();
        return this.getState();
      } catch (error) {
        lastError = error;
      }
    }
    this.setState({ status: "error", message: friendlyUpdateError(lastError) });
    return this.getState();
  }

  async download(): Promise<UpdateState> {
    if (this.state.status !== "available") throw new Error("当前没有可下载的新版本。");
    let lastError: unknown;
    for (let index = this.sourceIndex; index < this.sources.length; index += 1) {
      this.sourceIndex = index;
      const source = this.sources[index]!;
      try {
        if (index > 0) {
          autoUpdater.setFeedURL({ provider: "generic", url: source, channel: autoUpdater.channel });
          this.setState({ status: "checking", source, message: "下载主源不可用，正在切换备用源…" });
          await autoUpdater.checkForUpdates();
        }
        await autoUpdater.downloadUpdate();
        return this.getState();
      } catch (error) {
        lastError = error;
      }
    }
    this.setState({ status: "error", message: friendlyUpdateError(lastError) });
    return this.getState();
  }

  install(): void {
    if (this.state.status !== "downloaded") throw new Error("更新尚未下载完成。");
    autoUpdater.quitAndInstall(false, true);
  }

  private bindEvents(): void {
    autoUpdater.on("update-available", (info) => {
      this.setState({
        status: "available",
        availableVersion: info.version,
        source: this.sources[this.sourceIndex],
        message: `发现新版本 ${info.version}`,
      });
    });
    autoUpdater.on("update-not-available", () => {
      this.setState({ status: "up-to-date", message: "当前已是最新版本。" });
    });
    autoUpdater.on("download-progress", (progress) => {
      this.setState({
        status: "downloading",
        progress: Math.round(progress.percent * 10) / 10,
        message: `正在下载 ${Math.round(progress.percent)}%`,
      });
    });
    autoUpdater.on("update-downloaded", (info) => {
      this.setState({
        status: "downloaded",
        availableVersion: info.version,
        progress: 100,
        message: "更新已下载并通过签名校验，可以重启安装。",
      });
    });
    autoUpdater.on("error", (error) => {
      if (this.state.status === "checking") return;
      this.setState({ status: "error", message: friendlyUpdateError(error) });
    });
  }

  private setState(next: Partial<UpdateState>): void {
    this.state = { ...this.state, ...next, currentVersion: app.getVersion() };
    this.publish(this.getState());
  }
}

export async function loadUpdateSources(
  channel: "stable" | "alpha",
  overrideFile?: string,
): Promise<string[]> {
  const environmentSources = normalizeSources(process.env["ALLYCODE_UPDATE_URLS"]?.split(",") ?? []);
  if (environmentSources.length > 0) return environmentSources;
  const configFile = overrideFile ?? path.join(
    app.isPackaged ? process.resourcesPath : process.cwd(),
    "update-sources.json",
  );
  try {
    const document = JSON.parse(await fs.readFile(configFile, "utf8")) as UpdateSourcesDocument;
    if (document.schemaVersion !== 1) return [];
    return normalizeSources(document.channels[channel] ?? []);
  } catch {
    return [];
  }
}

function friendlyUpdateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "未知错误");
  return `更新源暂时不可用：${message}`;
}
