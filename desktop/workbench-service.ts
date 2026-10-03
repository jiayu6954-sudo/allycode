import fs from "node:fs/promises";
import path from "node:path";
import { dialog, shell } from "electron";
import { createHash } from "node:crypto";
import { DATA_DIR, loadSettings, saveSettings } from "../src/config/settings.js";
import { SettingsSchema } from "../src/config/schema.js";
import { WorkspaceSnapshots } from "../src/storage/workspace-snapshots.js";
import { assertSafeWorkspaceRoot } from "../src/tools/path-guard.js";
import { saveSkillDocument } from "../src/skills/loader.js";
import { runEngineCommand } from "../src/engines/process-utils.js";
import type { WorkbenchAction, WorkbenchResult } from "./shared.js";

export async function workbenchAction(action: WorkbenchAction, cwd: string, id?: string): Promise<WorkbenchResult> {
  if (cwd) assertSafeWorkspaceRoot(cwd);
  if (action === "inspect") {
    const environment = await Promise.all(["node", "npm", "python", "git"].map(async (command) => {
      try { const result = await runEngineCommand(command, ["--version"]); return `${command}: ${result.failed ? "未就绪" : result.stdout.trim()}`; }
      catch { return `${command}: 未安装或不在 PATH 中`; }
    }));
    const snapshots = cwd ? await new WorkspaceSnapshots(cwd).list() : [];
    return { message: environment.join("\n"), snapshots: snapshots.map(({id, label, createdAt}) => ({id, label, createdAt})) };
  }
  if (action === "open-project") { if (!cwd) throw new Error("请先选择项目"); const error = await shell.openPath(path.resolve(cwd)); if (error) throw new Error(error); return {message: "已打开项目成果目录"}; }
  if (action === "snapshot") { if (!cwd) throw new Error("请先选择项目"); const snapshot = await new WorkspaceSnapshots(cwd).create("用户保存版本"); return {message: `已保存版本 ${snapshot.createdAt}。依赖、构建输出和临时目录不包含在内。`}; }
  if (action === "restore") {
    if (!cwd || !id) throw new Error("请选择项目与版本");
    const approval = await dialog.showMessageBox({type:"warning",buttons:["取消","恢复版本"],defaultId:0,cancelId:0,message:"恢复所选版本会覆盖当前项目文件，并移除之后新增的受快照管理文件。",detail:"恢复前会自动备份当前版本。依赖、构建输出和临时目录不在恢复范围。"});
    if (approval.response !== 1) return {message:"已取消"};
    const result = await new WorkspaceSnapshots(cwd).restore(id);
    return {message:`已恢复 ${result.restoredFiles} 个文件；当前版本已备份，可再次恢复。`};
  }
  if (action === "import-skill" || action === "import-mcp") {
    const choice = await dialog.showOpenDialog({title: action === "import-skill" ? "导入 Markdown 工作流" : "导入 MCP 工具连接 JSON", properties:["openFile"], filters:[{name:"能力文件",extensions:action === "import-skill" ? ["md"] : ["json"]}]});
    if (choice.canceled || !choice.filePaths[0]) return {message:"已取消"};
    const file = choice.filePaths[0];
    if ((await fs.stat(file)).size > 100000) throw new Error("能力配置文件不能超过 100KB");
    const content = await fs.readFile(file,"utf8");
    const digest = createHash("sha256").update(content).digest("hex");
    if (action === "import-skill") {
      const approval = await dialog.showMessageBox({type:"question",buttons:["取消","导入"],defaultId:0,cancelId:0,message:"导入此工作流供新任务使用？",detail:`文件：${path.basename(file)}\nSHA256：${digest}\n${content.slice(0,1000)}`});
      if (approval.response !== 1) return {message:"已取消"};
      saveSkillDocument({id:`import-${digest.slice(0,16)}`,name:path.basename(file,".md").slice(0,100),body:content,enabled:true,triggers:[path.basename(file,".md").slice(0,80)]});
      return {message:"工作流已导入。新任务中提到工作流名称即可使用，也可在能力设置中修改触发词。"};
    }
    const parsed = SettingsSchema.shape.mcpServers.parse([JSON.parse(content)])[0]!;
    const approval = await dialog.showMessageBox({type:"warning",buttons:["取消","添加连接"],defaultId:0,cancelId:0,message:`添加工具连接 ${parsed.name}？`,detail:`${parsed.transport === "stdio" ? `此连接会启动本机程序：${parsed.command}` : `此连接会访问：${parsed.url}`}\n工具使用仍受项目权限控制。请确认配置来自可信来源。\nSHA256：${digest}`});
    if (approval.response !== 1) return {message:"已取消"};
    const settings = await loadSettings();
    if (settings.mcpServers.some((server) => server.name === parsed.name)) throw new Error("同名连接已存在，请在能力设置中修改，避免覆盖现有配置。");
    await saveSettings({mcpServers:[...settings.mcpServers,parsed]});
    return {message:"工具连接已添加；请在能力设置中连接自检，通过后用于新任务。"};
  }
  if (action === "install-codex") {
    const approval = await dialog.showMessageBox({type:"question",buttons:["取消","下载并安装"],defaultId:0,cancelId:0,message:"从 npm 安装官方 @openai/codex 到 AllyCode 私有目录？",detail:"需要 Node/npm 和网络。安装后仍需完成 Codex 账户登录；原生引擎继续可用。"});
    if (approval.response !== 1) return {message:"已取消"};
    const target = path.join(DATA_DIR,"engines","codex");
    await fs.mkdir(target,{recursive:true});
    const result = await runEngineCommand("npm",["install","--prefix",target,"--no-audit","--no-fund","@openai/codex"],{timeoutMs:240000});
    if (result.failed) throw new Error("安装失败。请检查 Node/npm 和网络连接后重试；现有引擎配置未更改。");
    const command = path.join(target,"node_modules",".bin",process.platform === "win32" ? "codex.cmd" : "codex");
    const probe = await runEngineCommand(command,["--version"]);
    if (probe.failed) throw new Error("已下载但启动自检未通过，未切换引擎。");
    const settings = await loadSettings();
    await saveSettings({agentEngine:{...settings.agentEngine,codexCommand:command}});
    return {message:`已安装 ${probe.stdout.trim()}。登录命令：\n"${command}" login\n登录后在 Agent 引擎面板重新检测。`};
  }
  throw new Error("不支持的工作台操作");
}
