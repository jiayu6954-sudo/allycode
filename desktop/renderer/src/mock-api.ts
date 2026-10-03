import type { AllyCodeSettings } from "../../../src/config/schema.js";
import {toDesktopMessages} from "../../conversation-view.js";
import type {
  AllyCodeDesktopApi,
  DesktopAgentEvent,
  DesktopMessage,
  SessionSummary,
  TaskSummary,
  WorkspaceEntry,
} from "../../shared.js";

const listeners = new Set<(event: DesktopAgentEvent) => void>();
const updateListeners = new Set<Parameters<AllyCodeDesktopApi["onUpdateState"]>[0]>();
let updateState: Awaited<ReturnType<AllyCodeDesktopApi["getUpdateState"]>> = {
  status: "idle",
  currentVersion: "0.11.0-alpha.5",
  message: "可手动检查新版本；不会在后台自动下载。",
};
const activeRuns = new Map<string, { taskId: string; timers: number[] }>();
const credentialStatus: Awaited<
  ReturnType<AllyCodeDesktopApi["getCredentialStatus"]>
> = {
  anthropic: true,
  openai: false,
  deepseek: false,
  qwen: false,
  groq: false,
  gemini: false,
  openrouter: false,
  ollama: true,
  moonshot: false,
  custom: false,
};

const settings: AllyCodeSettings = {
  provider: "deepseek",
  model: "deepseek-v4-pro",
  maxTokens: 32000,
  providerProtocol: "auto",
  reasoning: { mode: "auto", effort: "auto" },
  tokenBudget: { warningThreshold: 80 },
  executionBudget: {
    maxModelTurnsPerRun: 80,
    maxToolCallsPerRun: 300,
    enforceTaskLimits: false,
    maxModelTurnsPerTask: 160,
    maxToolCallsPerTask: 300,
  },
  agentEngine: {
    mode: "auto",
    fallbackToNative: true,
    codexCommand: "codex",
    deepseekHarnessCommand: "dsh",
  },
  defaultPermissions: {
    verification_status: "auto",
    phase_checkpoint: "auto",
    sources_to_excel: "auto",
    document_ocr: "auto",
    document_verify: "auto",
    document_format: "auto",
    vision_analyze: "auto",
    bash: "ask",
    file_write: "ask",
    file_edit: "ask",
    file_read: "auto",
    glob: "auto",
    grep: "auto",
    web_fetch: "ask",
    web_search: "auto",
    session_search: "auto",
    evidence_read: "auto",
    desktop_control: "ask",
    plan_update: "auto",
    git_commit: "ask",
    spawn_research: "auto",
    service_start: "ask",
    service_status: "auto",
    service_stop: "auto",
    browser_verify: "ask",
  },
  customRules: [],
  ui: { theme: "light", showThinking: false, showTokenCount: true, showCost: true },
  context: {
    maxHistoryMessages: 50,
    compactionThreshold: 80,
    claudeMdPaths: [],
    maxContextTokens: 60_000,
    keepRecentMessages: 20,
  },
  memory: {
    enabled: true,
    maxConversationChars: 12000,
    semanticRetrieval: true,
    embeddingModel: "nomic-embed-text",
    topK: 8,
    similarityThreshold: 0.25,
  },
  localModel: {
    autoDiscover: true,
    useForMemory: false,
    memoryModel: "qwen2.5:7b",
  },
  sandbox: {
    enabled: true,
    level: "standard",
    image: "node:20-slim",
    timeoutMs: 30000,
    maxMemoryMb: 512,
    allowNetwork: true,
    persistent: true,
    pidsLimit: 256,
    fallbackToHost: false,
  },
  search: { defaultProvider: "auto" },
  github: {},
  hooks: { preToolUse: [], postToolUse: [] },
  providerBaseUrls: {},
  mcpServers: [],
  onboarding: { completed: true, region: "cn" },
  updates: { enabled: true, channel: "alpha", automaticDownload: false },
};

const sessions: SessionSummary[] = [
  { id: "demo-1", title: "修复模型流式响应错误", updatedAt: new Date().toISOString(), cwd: "D:\\Projects\\allycode", model: "claude-sonnet-4-6" },
  { id: "demo-2", title: "修复模型流式响应错误", updatedAt: new Date(Date.now() - 3_600_000).toISOString(), cwd: "E:\\Workspaces\\客户项目\\库存管理", model: "claude-sonnet-4-6" },
  { id: "demo-3", title: "检查项目安全边界", updatedAt: new Date(Date.now() - 86_400_000).toISOString(), cwd: "D:\\Projects\\allycode", model: "claude-sonnet-4-6" },
];

const tasks: TaskSummary[] = [
  {
    id: "task-demo-1", projectId: "mock-project", sessionId: "demo-1",
    title: "修复模型流式响应错误", goal: "修复模型流式响应错误", status: "completed",
    cwd: "D:\\Projects\\allycode", createdAt: new Date(Date.now() - 7_200_000).toISOString(),
    updatedAt: new Date().toISOString(), resumable: false,
  },
  {
    id: "task-demo-2", projectId: "mock-inventory", sessionId: "demo-2",
    title: "修复模型流式响应错误", goal: "修复模型流式响应错误", status: "paused",
    cwd: "E:\\Workspaces\\客户项目\\库存管理", createdAt: new Date(Date.now() - 7_200_000).toISOString(),
    updatedAt: new Date(Date.now() - 3_600_000).toISOString(), resumable: true,
  },
  {
    id: "task-demo-3", projectId: "mock-project", sessionId: "demo-3",
    title: "检查项目安全边界", goal: "检查项目安全边界", status: "running",
    cwd: "D:\\Projects\\allycode", createdAt: new Date(Date.now() - 90_000_000).toISOString(),
    updatedAt: new Date(Date.now() - 86_400_000).toISOString(), resumable: false,
  },
];

const workspace: WorkspaceEntry[] = [
  { name: "desktop", path: "desktop", type: "directory", children: [
    { name: "renderer", path: "desktop/renderer", type: "directory" },
    { name: "main.ts", path: "desktop/main.ts", type: "file" },
    { name: "preload.ts", path: "desktop/preload.ts", type: "file" },
  ] },
  { name: "src", path: "src", type: "directory", children: [
    { name: "agent", path: "src/agent", type: "directory" },
    { name: "memory", path: "src/memory", type: "directory" },
    { name: "tools", path: "src/tools", type: "directory" },
  ] },
  { name: "docs", path: "docs", type: "directory" },
  { name: "package.json", path: "package.json", type: "file" },
  { name: "README.md", path: "README.md", type: "file" },
];

const savedMessages: DesktopMessage[] = [
  {
    id: "saved-user",
    role: "user",
    content: [{ type: "text", text: "检查模型流式响应链路，并解释故障原因。" }],
    timestamp: new Date().toISOString(),
  },
  {
    id: "saved-assistant",
    role: "assistant",
    content: [{ type: "text", text: "流式错误此前只被记录，却在 `finalMessage()` 前被吞掉。现在会保留原始错误，并在两个消费入口重新抛出。\n\n```ts\nif (this.streamError) throw this.streamError;\n```" }],
    timestamp: new Date().toISOString(),
  },
];

export function createMockDesktopApi(): AllyCodeDesktopApi {
  if (new URLSearchParams(window.location.search).has("onboarding")) {
    settings.onboarding.completed = false;
    credentialStatus.deepseek = false;
    credentialStatus.qwen = false;
    credentialStatus.moonshot = false;
  }
  return {
    async accountState() {return new URLSearchParams(window.location.search).has("account-preview")?{configured:true,serviceUrl:"https://preview.invalid"}:{configured:false};},
    async accountSend() {throw new Error("预览不发送邮件，请使用已配置服务的桌面应用。");},
    async accountVerify() {throw new Error("预览不创建真实账号。");},
    async accountLogout() {return {configured:false};},
    async accountDelete() {return {configured:false};},
    async setupState() {return {platform:"preview",installing:false,items:[{id:"documents",title:"Word、PDF 与 Excel 计算",ready:false,detail:"预览模式：未检测本机组件。"},{id:"vision",title:"完整视觉理解",ready:false,detail:"请在桌面应用中安装视觉组件。"}]};},
    async installComponents() {throw new Error("预览不执行安装，请打开桌面应用。");},
    async visionStatus() {return {directory:"预览模式：未访问本机模型",ready:false,busy:false,phase:"missing",message:"此页面是界面预览，不代表模型已安装。",downloadedBytes:0,totalBytes:9900000000,models:{qwen:"Qwen3.5-9B Q4_K_M",paddle:"PaddleOCR-VL-1.6 GGUF"}};},
    async visionInstall() {throw new Error("预览模式不执行模型下载，请在桌面应用中安装。");},
    async visionCancel() {},
    async importVisionFiles() {return ["AllyCode资料/预览样本.png"];},
    async workbenchAction() { return {message: "预览环境：工作台演示，不执行本机安装或文件修改。", snapshots: []}; },
    async getSettings() {
      return structuredClone(settings);
    },
    async getCredentialStatus() {
      return structuredClone(credentialStatus);
    },
    async inspectAgentEngines() {
      const checkedAt = new Date().toISOString();
      return [
        {
          engine: {
            contractVersion: 1,
            id: "native",
            name: "AllyCode 原生引擎",
            summary: "内置模型、记忆、Skills、MCP 与沙箱主链路。",
            maturity: "stable",
            capabilities: { streaming: true, resume: true, tools: true, skills: true, mcp: true, sandbox: true, trace: true, externalRuntime: false },
          },
          state: "ready",
          selectable: true,
          version: "0.11.0-alpha.5",
          detail: "内置运行时已就绪。",
          checkedAt,
        },
        {
          engine: {
            contractVersion: 1,
            id: "codex",
            name: "Codex 引擎",
            summary: "使用本机 Codex CLI。",
            maturity: "beta",
            capabilities: { streaming: true, resume: false, tools: true, skills: true, mcp: true, sandbox: true, trace: true, externalRuntime: true },
          },
          state: "needs_auth",
          selectable: false,
          version: "codex-cli 0.149.0",
          detail: "已安装，但 Codex 尚未登录。",
          checkedAt,
        },
        {
          engine: {
            contractVersion: 1,
            id: "deepseek-harness",
            name: "DeepSeek Harness",
            summary: "开发预览版隔离适配。",
            maturity: "developer-preview",
            capabilities: { streaming: true, resume: true, tools: true, skills: true, mcp: false, sandbox: true, trace: true, externalRuntime: true },
          },
          state: "not_installed",
          selectable: false,
          detail: "未安装 DeepSeek Harness。",
          checkedAt,
        },
      ];
    },
    async getBenchmarkLab(workspace) {
      return {
        id: "binary-market-protocol-agent-challenge",
        title: "Binary Market Protocol 工业级盲测",
        description: "基于公开高预算真实需求改编：从零交付 Solana/Anchor 合约、索引 API、React 前端、预言机结算与安全测试。",
        preparedWorkspace: workspace,
        principles: ["模型、Agent 引擎和验收器分别记录。", "评分器位于项目目录外。", "只采信可复跑证据。"],
      };
    },
    async prepareBenchmarkWorkspace() {
      return { canceled: false, workspace: "D:\\Projects\\AllyCode-Binary-Market-Challenge" };
    },
    async runBenchmark() {
      return {
        challenge: "binary-market-protocol-agent-challenge",
        generatedAt: new Date().toISOString(),
        score: 84,
        total: 100,
        boundary: "本分数仅覆盖固定本地合同。",
        results: [
          { id: "startup", section: "基础运行", points: 10, earned: 10, passed: true, detail: "API 与 Web 均已启动" },
          { id: "webhook", section: "Webhook", points: 10, earned: 4, passed: false, detail: "重复事件处理不完整" },
        ],
      };
    },
    async listSkills() {
      return [
        {
          id: "debug-workflow",
          name: "调试工作流",
          triggers: ["调试", "报错", "debug"],
          body: "先定位错误与根因，再做最小修改并运行相关测试。",
          enabled: true,
        },
      ];
    },
    async saveSkill(skill) {
      return [structuredClone(skill)];
    },
    async deleteSkill() {
      return [];
    },
    async openSkillsFolder() {},
    async testMcpServers(servers) {
      return servers.map((server) => ({
        name: server.name,
        ok: true,
        toolCount: 2,
        tools: ["read_project", "search_docs"],
        latencyMs: 86,
      }));
    },
    async saveSettings(next) {
      Object.assign(settings, structuredClone(next));
      if (next.apiKey) credentialStatus.anthropic = true;
      if (next.openaiApiKey) credentialStatus.openai = true;
      if (next.deepseekApiKey) credentialStatus.deepseek = true;
      if (next.qwenApiKey) credentialStatus.qwen = true;
      if (next.groqApiKey) credentialStatus.groq = true;
      if (next.geminiApiKey) credentialStatus.gemini = true;
      if (next.openrouterApiKey) credentialStatus.openrouter = true;
      if (next.moonshotApiKey) credentialStatus.moonshot = true;
      credentialStatus.custom = Boolean(next.customProviderUrl);
      return structuredClone(settings);
    },
    async testProvider(next) {
      const now = new Date().toISOString();
      const credentialFields = {
        anthropic: next.apiKey,
        openai: next.openaiApiKey,
        deepseek: next.deepseekApiKey,
        qwen: next.qwenApiKey,
        groq: next.groqApiKey,
        gemini: next.geminiApiKey,
        openrouter: next.openrouterApiKey,
        moonshot: next.moonshotApiKey,
        custom: next.customProviderKey,
        ollama: "local",
      };
      const configured = Boolean(credentialFields[next.provider] || credentialStatus[next.provider]);
      return {
        provider: next.provider,
        model: next.model,
        capability: {
          level: configured ? "agent_ready" : "unavailable",
          protocol: next.providerProtocol === "responses"
            ? "responses"
            : next.provider === "anthropic"
              ? "anthropic"
              : "chat_completions",
          nativeToolRoundtrip: configured,
          source: "live_probe",
        },
        ok: configured,
        testedAt: now,
        stages: configured ? [
          { stage: "configuration", ok: true, message: "配置字段有效，Provider 已创建。", latencyMs: 1 },
          { stage: "model_discovery", ok: true, message: "模型列表读取成功（HTTP 200）。", latencyMs: 62 },
          { stage: "chat", ok: true, message: "基础流式对话成功并返回文本。", latencyMs: 410 },
          { stage: "tool_call", ok: true, message: "模型成功生成结构化工具调用。", latencyMs: 530 },
          { stage: "tool_result_roundtrip", ok: true, message: "工具结果回传与第二轮续接成功。", latencyMs: 360 },
        ] : [{ stage: "configuration", ok: false, message: "未配置此供应商的 API 密钥。" }],
        fieldErrors: configured ? {} : { credential: "未配置此供应商的 API 密钥。" },
      };
    },
    async listProviderModels(next) {
      const ids = next.provider === "deepseek"
        ? ["deepseek-v4-flash", "deepseek-v4-pro"]
        : [next.model];
      return {
        provider: next.provider,
        retrieval: "live",
        fetchedAt: new Date().toISOString(),
        models: ids.map((id) => {
          const official = next.provider === "deepseek" && id.startsWith("deepseek-v4-");
          const protocol = next.provider === "anthropic"
            ? "anthropic" as const
            : next.provider === "openai"
              ? "responses" as const
              : "chat_completions" as const;
          return {
            id,
            provider: next.provider,
            source: "live" as const,
            verification: official ? "official" as const : "provider-listed" as const,
            protocols: official
              ? ["chat_completions" as const, "anthropic" as const]
              : [protocol],
            capabilities: {
              protocol,
              streaming: true,
              toolCalls: official ? "native" as const : "unverified" as const,
              reasoning: official ? "supported" as const : "unverified" as const,
              vision: "unverified" as const,
              ...(official ? { contextWindow: 1_000_000, maxOutputTokens: 384_000 } : {}),
              source: official ? "official" as const : "provider" as const,
              notes: [],
            },
          };
        }),
      };
    },
    async openProviderConsole() {},
    async getUpdateState() {
      return structuredClone(updateState);
    },
    async checkForUpdates() {
      updateState = {
        status: "up-to-date",
        currentVersion: "0.11.0-alpha.5",
        message: "当前已是最新版本。",
      };
      for (const listener of updateListeners) listener(structuredClone(updateState));
      return structuredClone(updateState);
    },
    async downloadUpdate() {
      updateState = { ...updateState, status: "downloaded", progress: 100, message: "更新已下载并通过签名校验，可以重启安装。" };
      for (const listener of updateListeners) listener(structuredClone(updateState));
      return structuredClone(updateState);
    },
    async installUpdate() {},
    onUpdateState(listener) {
      updateListeners.add(listener);
      return () => updateListeners.delete(listener);
    },
    async chooseWorkspace() {
      const current = localStorage.getItem("allycode.cwd");
      return current?.startsWith("D:\\")
        ? "E:\\Workspaces\\inventory-agent"
        : "D:\\Projects\\allycode";
    },
    async listWorkspace() {
      return structuredClone(workspace);
    },
    async listSessions() {
      return structuredClone(sessions);
    },
    async loadSession(id) {
      if (id !== "demo-1") return toDesktopMessages([
        {role:"user",content:id === "demo-2" ? "检查库存项目的数据保存。" : "检查安全边界。"},
        {role:"assistant",content:[{type:"tool_use",id:"saved-plan",name:"plan_update",input:{items:[{step:"核对项目文件",status:"completed"},{step:"运行自动化检查",status:"in_progress"}]}}]},
        {role:"user",content:[{type:"tool_result",tool_use_id:"saved-plan",content:"已保存"}]},
        {role:"assistant",content:[{type:"tool_use",id:"saved-check",name:"bash",input:{command:"npm test"}}]},
        {role:"user",content:[{type:"tool_result",tool_use_id:"saved-check",content:"库存保存测试未通过，需修复。",is_error:true}]},
        {role:"assistant",content:"检查结果已保存，可继续修复。"},
      ]);
      return structuredClone(savedMessages);
    },
    async exportSession(id) {
      const session = sessions.find((item) => item.id === id);
      if (!session) throw new Error("找不到要导出的会话。");
      return { canceled: false, filePath: `D:\\Exports\\${session.title}.md` };
    },
    async deleteSessions(request) {
      const ids = new Set(request.sessionIds);
      const linked = tasks.filter((task) => task.sessionId && ids.has(task.sessionId));
      if (linked.some((task) => task.status === "running" || task.status === "waiting_permission")) {
        throw new Error("运行中或等待确认的任务不能删除，请先暂停任务。");
      }
      const beforeSessions = sessions.length;
      for (let index = sessions.length - 1; index >= 0; index--) {
        if (ids.has(sessions[index]!.id)) sessions.splice(index, 1);
      }
      let deletedEventCount = 0;
      if (request.includeDurableTasks) {
        for (let index = tasks.length - 1; index >= 0; index--) {
          if (tasks[index]!.sessionId && ids.has(tasks[index]!.sessionId!)) {
            tasks.splice(index, 1);
            deletedEventCount += 3;
          }
        }
      } else {
        for (const task of linked) task.sessionId = undefined;
      }
      return {
        deletedSessionCount: beforeSessions - sessions.length,
        detachedTaskCount: request.includeDurableTasks ? 0 : linked.length,
        deletedTaskCount: request.includeDurableTasks ? linked.length : 0,
        deletedEventCount,
      };
    },
    async getMemoryOverview() {
      return {
        user: "偏好简洁、可验证的执行结果。",
        projectContext: "AllyCode 是一个本地优先的桌面 Agent 平台。",
        projectDecisions: "任务状态使用持久化检查点，模型供应商保持可插拔。",
        projectLearnings: "长回答必须使用独立滚动区域；只读操作不重复确认。",
        taskCount: tasks.length,
        resumableTaskCount: tasks.filter((task) => task.resumable).length,
      };
    },
    async listTasks(cwd) {
      return structuredClone(cwd ? tasks.filter((task) => task.cwd === cwd) : tasks);
    },
    async getMonitorReport(taskId) {
      const task = tasks.find((item) => item.id === taskId) ?? tasks[0]!;
      const now = Date.now();
      return {
        nextAfterId: 18,
        report: {
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          task: {
            id: task.id,
            title: task.title,
            goal: task.goal,
            status: task.status,
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
            provider: "deepseek",
            model: "deepseek-v4-pro",
            protocol: "chat_completions",
          },
          metrics: {
            eventCount: 18, analyzedEventCount: 18, runCount: 1, durationMs: 28_400, modelTurns: 4,
            firstSignalMs: 820, toolCalls: 6, toolSuccesses: 5, toolErrors: 1,
            toolDenied: 0, permissionRequests: 1, planUpdates: 3,
            completedPlanItems: 3, totalPlanItems: 3, checkpoints: 4, recoveries: 0,
            inputTokens: 18_420, outputTokens: 2_610, cacheReadTokens: 9_200,
            cacheWriteTokens: 0, cacheReadRate: 0.33, failureIncidents: 0,
          },
          currentPlan: [
            { step: "读取项目结构与业务规则", status: "completed" },
            { step: "修复价格计算并补充测试", status: "completed" },
            { step: "运行完整验证并汇报证据", status: "completed" },
          ],
          scores: [
            { dimension: "completion", label: "任务完成度", score: 100, status: "measured", evidence: "任务已完成；仍需结合告警判断质量。" },
            { dimension: "planning", label: "计划一致性", score: 100, status: "measured", evidence: "3/3 个计划步骤完成。" },
            { dimension: "tools", label: "工具可靠性", score: 83, status: "measured", evidence: "5 成功、1 失败。" },
            { dimension: "evidence", label: "证据完整性", score: 100, status: "measured", evidence: "检测到写入后的测试命令。" },
            { dimension: "continuity", label: "记忆与恢复", score: 100, status: "measured", evidence: "4 个检查点。" },
            { dimension: "safety", label: "安全与授权", score: 100, status: "measured", evidence: "1 次授权请求。" },
            { dimension: "efficiency", label: "成本与效率", score: 85, status: "measured", evidence: "Provider 上报缓存读取 9200 tokens。" },
          ],
          alerts: [{
            id: "repeated-tool-9", severity: "warning", code: "repeated_tool",
            title: "可能存在重复操作", detail: "grep 使用相同参数调用 3 次。",
            evidenceEventIds: [9, 11, 13],
          }],
          timeline: [
            { id: 18, createdAt: new Date(now).toISOString(), category: "model", severity: "info", title: "模型用量", detail: "输入 6200 · 输出 810 · 缓存读取 4100" },
            { id: 17, createdAt: new Date(now - 1400).toISOString(), category: "tool", severity: "info", title: "工具完成：bash", detail: "命令退出码：0" },
            { id: 16, createdAt: new Date(now - 4300).toISOString(), category: "tool", severity: "info", title: "开始工具：bash", detail: "命令：npm test" },
            { id: 15, createdAt: new Date(now - 5200).toISOString(), category: "plan", severity: "info", title: "工作计划更新", detail: "3 个步骤" },
          ],
          limitations: ["确定性规则不能替代业务验收。"],
        },
      };
    },
    async exportMonitorReport() {
      return { canceled: false, filePath: "D:\\Exports\\AllyCode-Diagnostic-demo.json" };
    },
    async startAgent(request) {
      const runId = crypto.randomUUID();
      const taskId = request.taskId ?? crypto.randomUUID();
      const now = new Date().toISOString();
      const existing = tasks.find((task) => task.id === taskId);
      if (existing) {
        existing.status = "running";
        existing.updatedAt = now;
      } else {
        tasks.unshift({
          id: taskId,
          projectId: "mock-project",
          sessionId: request.sessionId,
          title: request.prompt.slice(0, 60),
          goal: request.prompt,
          status: "running",
          cwd: request.cwd,
          createdAt: now,
          updatedAt: now,
          resumable: false,
        });
      }
      const currentTask = tasks.find((task) => task.id === taskId)!;
      currentTask.resumable = false;
      for (const listener of listeners) {
        listener({ runId, type: "task_status", task: structuredClone(currentTask) });
      }
      const responseParagraphs = [
        "我已经完成第一轮项目检查，下面按架构、运行链路、风险和建议四个部分汇报。",
        "一、应用入口负责读取配置、建立会话并初始化模型供应商。桌面端通过受限的预加载桥接调用主进程能力，渲染层无法直接访问 Node.js。",
        "二、对话请求进入 Agent 循环后，会把当前用户消息、历史会话和项目上下文组合起来，再交给所选模型生成下一步动作。",
        "三、模型如果请求工具调用，系统会先经过权限分类器。读取类操作通常可直接执行，写文件、运行命令和访问网络则按配置请求确认。",
        "四、工具执行结果会回到同一条会话链路，模型能够继续分析结果，而不是丢失前一步状态。执行记录会在右侧以折叠项目显示。",
        "五、会话完成后，更新后的完整历史会保存到本地。再次打开同一会话时，用户消息、助手回复和必要的工具上下文可以恢复。",
        "六、长期记忆与普通会话历史分开保存。语义检索只注入和当前任务相关的片段，避免把无关项目内容混入上下文。",
        "七、项目文件访问经过根目录边界检查，并处理符号链接路径，防止工具通过相对路径跳出用户选择的工作目录。",
        "八、终端命令可按设置进入 Docker 沙箱。严格模式会关闭网络并限制工作目录写入范围，降低误操作影响。",
        "九、模型供应商层统一转换流式文本、思考内容、工具调用和错误，桌面端因此可以在不同 API 之间保持一致的交互。",
        "十、当前界面采用独立消息滚动容器。输入区固定在会话底部，不参与消息列表高度计算，因此长回答不会把输入框推出窗口。",
        "十一、自动跟随只在用户停留于消息底部时生效。如果用户向上查看旧内容，新输出不会强制拉回底部。",
        "十二、当用户离开底部超过一定距离时，界面会显示“回到底部”按钮，点击后平滑回到最新消息。",
        "十三、连续流式输出使用即时容器内滚动，不再调用会影响祖先布局的 scrollIntoView，因此侧边栏和顶部栏不会跟随跳动。",
        "十四、主滚动条使用固定占位，内容从短变长时不会突然挤压对话宽度，也不会造成文本左右抖动。",
        "十五、模型与 API 设置保留在顶部明显入口中。切换供应商后会给出对应默认模型，同时仍允许用户手动填写模型名称。",
        "十六、建议下一步继续增加差异审阅、文件引用和会话搜索，但这些功能应保持为可选面板，避免干扰主对话流程。",
        "以上检查用于模拟较长的真实任务输出，以验证滚动、输入框固定和连续流式消息的稳定性。",
      ];
      const responseEvents: Array<{ delay: number; event: DesktopAgentEvent }> =
        responseParagraphs.map((paragraph, index) => ({
          delay: 5200 + index * 180,
          event: {
            runId,
            event: {
              type: "text_delta",
              delta: `${index === 0 ? "" : "\n\n"}${paragraph}`,
            },
          },
        }));
      const finalDelay = 5200 + responseParagraphs.length * 180;
      const permissionEvents: Array<{ delay: number; event: DesktopAgentEvent }> =
        /修改|写入|删除/.test(request.prompt)
          ? [{
              delay: 900,
              event: {
                runId,
                type: "permission",
                requestId: "mock-permission",
                request: {
                  toolName: "file_edit",
                  input: { path: "src/example.ts" },
                  riskLevel: "moderate",
                  description: "编辑文件：src/example.ts",
                },
              },
            }]
          : [];
      const timers = sequence([
        { delay: 80, event: { runId, event: { type: "status", phase: "waiting_model", iteration: 1 } } },
        { delay: 300, event: { runId, event: { type: "plan_update", items: [{step:"检查项目运行链路",status:"in_progress"},{step:"核验结果并汇报",status:"pending"}] } } },
        { delay: 600, event: { runId, event: { type: "status", phase: "streaming", iteration: 1 } } },
        { delay: 650, event: { runId, event: { type: "text_delta", delta: "我先读取相关代码并核对真实执行链路。" } } },
        { delay: 700, event: { runId, event: { type: "thinking_delta", delta: "正在检查相关运行链路…" } } },
        ...permissionEvents,
        { delay: 1200, event: { runId, event: { type: "tool_pending", toolName: "grep", toolId: "tool-1", input: { pattern: "streamError", path: "src/providers" } } } },
        { delay: 1400, event: { runId, event: { type: "status", phase: "tool_running", iteration: 1, toolName: "grep", toolId: "tool-1" } } },
        { delay: 1420, event: { runId, event: { type: "tool_start", toolName: "grep", toolId: "tool-1", input: { pattern: "streamError", path: "src/providers" } } } },
        { delay: 2600, event: { runId, event: { type: "tool_result", toolId: "tool-1", toolName: "grep", content: "src/providers/openai-compatible.ts: streamError", isError: false } } },
        { delay: 2640, event: { runId, event: { type: "status", phase: "waiting_model_after_tool", iteration: 1 } } },
        { delay: 2700, event: { runId, event: { type: "plan_update", items: [{step:"检查项目运行链路",status:"completed"},{step:"核验结果并汇报",status:"in_progress"}] } } },
        { delay: 5100, event: { runId, event: { type: "status", phase: "streaming", iteration: 2 } } },
        ...responseEvents,
        { delay: finalDelay - 20, event: { runId, event: { type: "status", phase: "completed", iteration: 2, stopReason: "end_turn" } } },
        { delay: finalDelay, event: { runId, event: { type: "done", stopReason: "end_turn" } } },
        {
          delay: finalDelay + 40,
          before: () => {
            currentTask.status = "completed";
            currentTask.updatedAt = new Date().toISOString();
            currentTask.resumable = false;
          },
          event: { runId, type: "task_status", task: currentTask },
        },
        { delay: finalDelay + 100, event: { runId, type: "complete", sessionId: "demo-new", taskId } },
      ]);
      activeRuns.set(runId, { taskId, timers });
      return { runId, taskId };
    },
    async steerAgent(runId,text) {
      if(!activeRuns.has(runId))throw new Error("任务已结束，请重新发送。");
      const id=crypto.randomUUID();
      setTimeout(()=>{for(const listener of listeners)listener({runId,event:{type:"user_steering",id,text,createdAt:new Date().toISOString()}});},300);
      return {id,status:"queued"};
    },
    async resumeTask(taskId) {
      const task = tasks.find((item) => item.id === taskId);
      if (!task) throw new Error("Task not found");
      return this.startAgent({
        prompt: "继续上次中断的任务",
        cwd: task.cwd,
        sessionId: task.sessionId,
        taskId,
        resume: true,
      });
    },
    async continuePhase(taskId) { return this.resumeTask(taskId); },
    async abortAgent(runId) {
      const active = activeRuns.get(runId);
      if (!active) return;
      for (const timer of active.timers) window.clearTimeout(timer);
      const task = tasks.find((item) => item.id === active.taskId);
      if (task) {
        task.status = "paused";
        task.resumable = true;
        task.sessionId = task.sessionId ?? "demo-new";
        task.updatedAt = new Date().toISOString();
        for (const listener of listeners) {
          listener({ runId, type: "task_status", task: structuredClone(task) });
          listener({ runId, type: "paused", taskId: task.id, sessionId: task.sessionId });
        }
      }
      activeRuns.delete(runId);
    },
    async resolvePermission() {},
    onAgentEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    platform: "win32",
  };
}

function sequence(items: Array<{
  delay: number;
  event: DesktopAgentEvent;
  before?: () => void;
}>): number[] {
  const timers: number[] = [];
  for (const item of items) {
    timers.push(window.setTimeout(() => {
      item.before?.();
      for (const listener of listeners) listener(item.event);
    }, item.delay));
  }
  return timers;
}
