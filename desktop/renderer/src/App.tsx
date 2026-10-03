import { WorkbenchPanel } from "./WorkbenchPanel.js";
import { AccountPanel } from "./AccountPanel.js";
import { SetupPanel } from "./SetupPanel.js";
import { VisionPanel } from "./VisionPanel.js";
import { TaskPlan } from "./TaskPlan.js";
import { conversationTools, updateInlinePlan } from "../../conversation-view.js";
import type { DesktopContentBlock } from "../../shared.js";
import { PermissionCard } from "./PermissionCard.js";
import { presentPermission } from "./permission-presentation.js";
import { BUILD_INFO } from "../../../src/build-info.js";
import { FormEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AllyCodeSettings } from "../../../src/config/schema.js";
import type { PermissionRequest } from "../../../src/types/permissions.js";
import type { AgentPhase } from "../../../src/types/agent.js";
import type { ProviderTestResult } from "../../../src/providers/diagnostics.js";
import type { ModelCatalogResult } from "../../../src/providers/model-catalog.js";
import type { SkillDocument } from "../../../src/skills/loader.js";
import type { AgentMonitorReport } from "../../../src/observability/agent-monitor.js";
import type { AgentEngineHealth, AgentEngineMode } from "../../../src/engines/types.js";
import type {
  DesktopAgentEvent,
  DeleteSessionsRequest,
  DesktopMessage,
  BenchmarkLabState,
  BenchmarkRunReport,
  MemoryOverview,
  MCPServerTestResult,
  ProviderCredentialStatus,
  SessionSummary,
  TaskSummary,
  UpdateState,
  WorkspaceEntry,
} from "../../shared.js";
import { isResumeIntent } from "./resume-intent.js";
import { PhaseCheckpointSchema } from "../../../src/agent/phase-workflow.js";

interface Activity {
  id: string;
  name: string;
  detail: string;
  status: "pending" | "running" | "success" | "error" | "denied";
  result?: string;
}

type AgentDisplayPhase = AgentPhase | "idle" | "thinking";

export function App(): JSX.Element {
  const [accountOpen,setAccountOpen]=useState(false);
  const [setupOpen,setSetupOpen]=useState(false);
  const [settings, setSettings] = useState<AllyCodeSettings | null>(null);
  const [credentialStatus, setCredentialStatus] =
    useState<ProviderCredentialStatus | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [allTasks, setAllTasks] = useState<TaskSummary[]>([]);
  const [sessionId, setSessionId] = useState<string>();
  const [taskId, setTaskId] = useState<string>();
  const [cwd, setCwd] = useState(localStorage.getItem("allycode.cwd") ?? "");
  const workspaceRef = useRef(cwd);
  workspaceRef.current = cwd;
  const [tree, setTree] = useState<WorkspaceEntry[]>([]);
  const [messages, setMessages] = useState<DesktopMessage[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [workingPlan, setWorkingPlan] = useState<NonNullable<TaskSummary["plan"]>>([]);
  const [draft, setDraft] = useState("");
  const [sendingSteering,setSendingSteering] = useState(false);
  const [steeringMessages,setSteeringMessages] = useState<Array<{id:string;text:string;status:"queued"|"applied"}>>([]);
  const [runId, setRunId] = useState<string>();
  const boundRunRef = useRef<string>();
  const startingRunRef = useRef(false);
  const queuedEventsRef = useRef<DesktopAgentEvent[]>([]);
  const selectionEpochRef = useRef(0);
  const [permission, setPermission] = useState<{
    requestId: string;
    request: PermissionRequest;
  }>();
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [memoryOverview, setMemoryOverview] = useState<MemoryOverview>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [workbenchOpen, setWorkbenchOpen] = useState(false);
  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false);
  const [enginesOpen, setEnginesOpen] = useState(false);
  const [benchmarkOpen, setBenchmarkOpen] = useState(false);
  const [monitorOpen, setMonitorOpen] = useState(false);
  const [monitorReport, setMonitorReport] = useState<AgentMonitorReport>();
  const [monitorError, setMonitorError] = useState("");
  const [activityOpen, setActivityOpen] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [notice, setNotice] = useState("");
  const [agentPhase, setAgentPhase] = useState<AgentDisplayPhase>("idle");
  const [runStartedAt, setRunStartedAt] = useState<number>();
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [managingSessions, setManagingSessions] = useState(false);
  const [sessionMenu, setSessionMenu] = useState<{ id: string; top: number; left: number }>();
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(new Set());
  const [deleteRequest, setDeleteRequest] = useState<DeleteSessionsRequest>();
  const [deletingSessions, setDeletingSessions] = useState(false);
  const [updateState, setUpdateState] = useState<UpdateState>();
  const messagesRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  const isRunning = Boolean(runId);
  const projectName = cwd
    ? cwd.split(/[\\/]/).filter(Boolean).at(-1)
    : "尚未选择项目";

  useEffect(() => {
    void refreshSettings();
    void refreshSessions();
    if (cwd) void refreshTasks(cwd);
    if (cwd) void refreshTree(cwd);
    void window.allycode.getUpdateState().then(setUpdateState);
    const unsubscribeAgent = window.allycode.onAgentEvent(handleAgentEvent);
    const unsubscribeUpdates = window.allycode.onUpdateState(setUpdateState);
    return () => {
      unsubscribeAgent();
      unsubscribeUpdates();
    };
  }, []);

  useEffect(() => {
    if (!monitorOpen || !taskId) return;
    let active = true;
    const refresh = async () => {
      try {
        const snapshot = await window.allycode.getMonitorReport(taskId);
        if (active) {
          setMonitorReport(snapshot.report);
          setMonitorError("");
        }
      } catch (error) {
        if (active) setMonitorError(localizeError(String(error)));
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [monitorOpen, taskId]);

  useEffect(() => {
    function closeSessionMenu(event: MouseEvent): void {
      if (!(event.target as Element).closest(".session-actions")) {
        setSessionMenu(undefined);
      }
    }
    function closeSessionMenuWithKeyboard(event: KeyboardEvent): void {
      if (event.key === "Escape") setSessionMenu(undefined);
    }
    document.addEventListener("click", closeSessionMenu);
    document.addEventListener("keydown", closeSessionMenuWithKeyboard);
    return () => {
      document.removeEventListener("click", closeSessionMenu);
      document.removeEventListener("keydown", closeSessionMenuWithKeyboard);
    };
  }, []);

  useEffect(() => {
    if (!runStartedAt || agentPhase === "idle") return;
    const updateElapsed = () => setElapsedSeconds(
      Math.max(0, Math.floor((Date.now() - runStartedAt) / 1000)),
    );
    updateElapsed();
    if (agentPhase === "completed") return;
    const timer = window.setInterval(updateElapsed, 250);
    return () => window.clearInterval(timer);
  }, [runStartedAt, agentPhase]);

  useLayoutEffect(() => {
    const container = messagesRef.current;
    if (!container || !stickToBottomRef.current) return;
    container.scrollTop = container.scrollHeight;
    setShowScrollToBottom(false);
  }, [messages]);

  function handleMessageScroll(): void {
    const container = messagesRef.current;
    if (!container) return;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    const shouldStick = distanceFromBottom < 96;
    stickToBottomRef.current = shouldStick;
    setShowScrollToBottom(!shouldStick);
  }

  function scrollMessagesToBottom(behavior: ScrollBehavior = "smooth"): void {
    const container = messagesRef.current;
    if (!container) return;
    stickToBottomRef.current = true;
    setShowScrollToBottom(false);
    container.scrollTo({ top: container.scrollHeight, behavior });
  }

  async function refreshSettings(): Promise<void> {
    const [nextSettings, nextCredentialStatus] = await Promise.all([
      window.allycode.getSettings(),
      window.allycode.getCredentialStatus(),
    ]);
    setSettings(nextSettings);
    setCredentialStatus(nextCredentialStatus);
  }

  async function refreshSessions(): Promise<void> {
    const [nextSessions, nextTasks] = await Promise.all([
      window.allycode.listSessions(),
      window.allycode.listTasks(),
    ]);
    setSessions(nextSessions);
    setAllTasks(nextTasks);
  }

  async function refreshTasks(workspace?: string): Promise<void> {
    const next = await window.allycode.listTasks(workspace);
    if (workspace === workspaceRef.current || !workspace && !workspaceRef.current) setTasks(next);
  }

  async function refreshTree(workspace: string): Promise<void> {
    const next = await window.allycode.listWorkspace(workspace);
    if (workspace === workspaceRef.current) setTree(next);
  }

  async function openMemory(): Promise<void> {
    if (!cwd) {
      setNotice("请先选择项目目录，再查看项目记忆");
      window.setTimeout(() => setNotice(""), 2200);
      return;
    }
    setMemoryOverview(await window.allycode.getMemoryOverview(cwd, sessionId));
    setMemoryOpen(true);
  }

  function handleAgentEvent(payload: DesktopAgentEvent): void {
    if (startingRunRef.current) { queuedEventsRef.current.push(payload); return; }
    if (payload.runId !== boundRunRef.current) return;
    if ("event" in payload) {
      const event = payload.event;
      if (event.type === "status") setAgentPhase(event.phase);
      else if (event.type === "stream_signal") return;
      else if (event.type === "text_delta") {
        setAgentPhase("streaming");
        appendAssistantText(event.delta);
      } else if (event.type === "thinking_delta") {
        setAgentPhase("thinking");
        appendThinking();
      } else if (event.type === "user_steering") {
        setPermission(undefined);
        setActivities(current=>current.map(item=>item.status==="pending"?{...item,status:"denied",result:"用户已补充要求，本操作未执行。"}:item));
        setWorkingPlan([]);
        setSteeringMessages(current=>current.some(item=>item.id===event.id)?current.map(item=>item.id===event.id?{...item,status:"applied"}:item):[...current,{id:event.id,text:event.text,status:"applied"}]);
        setMessages(current=>current.some(message=>message.id===event.id)?current:[...current.map(message=>message.streaming?{...message,streaming:false}:message),{id:event.id,role:"user",content:[{type:"text",text:event.text}],timestamp:event.createdAt},{id:crypto.randomUUID(),role:"assistant",content:[],timestamp:new Date().toISOString(),streaming:true}]);
      }
      else if (event.type === "tool_pending") {
        updateStreamingContent(content => [...content, {type:"tool_use",toolName:event.toolName,toolId:event.toolId,input:event.input,status:"pending"}]);
        setActivities((current) => [...current, {
          id: event.toolId,
          name: event.toolName,
          detail: summarize(event.input),
          status: "pending",
        }]);
      } else if (event.type === "tool_start") {
        updateActivity(event.toolId, { status: "running" });
      } else if (event.type === "tool_result") {
        updateActivity(event.toolId, {
          status: event.isError ? "error" : "success",
          result: event.content,
        });
      } else if (event.type === "tool_denied") {
        updateActivity(event.toolId, { status: "denied" });
      } else if (event.type === "plan_update") {
        setWorkingPlan(event.items);
        updateStreamingContent(content => updateInlinePlan(content, event.items));
      } else if (event.type === "error") {
        appendSystemMessage(localizeError(event.error.message));
      }
      return;
    }
    if (payload.type === "permission") {
      setPermission({ requestId: payload.requestId, request: payload.request });
    } else if (payload.type === "task_status") {
      setTaskId(payload.task.id);
      if (payload.task.plan) setWorkingPlan(payload.task.plan);
      setTasks((current) => [
        payload.task,
        ...current.filter((task) => task.id !== payload.task.id),
      ]);
      setAllTasks((current) => [
        payload.task,
        ...current.filter((task) => task.id !== payload.task.id),
      ]);
    } else if (payload.type === "delivery_receipt") {
      setMessages(current=>[...current,{id:`receipt-${payload.runId}`,role:"system",content:[{type:"text",text:payload.rendered}],timestamp:payload.receipt.generatedAt}]);
    } else if (payload.type === "complete") {
      setSessionId(payload.sessionId);
      setTaskId(payload.taskId);
      setMessages((current) =>
        current.map((message) => message.streaming ? { ...message, streaming: false } : message)
      );
      setRunId(undefined);
      setAgentPhase("completed");
      void refreshSessions();
      void refreshTasks(workspaceRef.current || undefined);
    } else if (payload.type === "paused") {
      setSessionId(payload.sessionId);
      setTaskId(payload.taskId);
      setMessages((current) =>
        current.map((message) => message.streaming ? { ...message, streaming: false } : message)
      );
      setRunId(undefined);
      setAgentPhase("completed");
      setNotice(payload.message ?? "任务已暂停，执行状态和对话检查点已保存");
      window.setTimeout(() => setNotice(""), payload.reason === "run_budget" ? 6200 : 2600);
      void refreshSessions();
      void refreshTasks(workspaceRef.current || undefined);
    } else if (payload.type === "fatal") {
      appendSystemMessage(localizeError(payload.message));
      setMessages((current) =>
        current.map((message) => message.streaming ? { ...message, streaming: false } : message)
      );
      setRunId(undefined);
      setAgentPhase("completed");
      void refreshTasks(workspaceRef.current || undefined);
    }
  }

  function appendAssistantText(delta: string): void {
    setMessages((current) => {
      const assistantIndex = findStreamingAssistant(current);
      if (assistantIndex < 0) return current;
      const next = [...current];
      const assistant = next[assistantIndex]!;
      const content = [...assistant.content];
      const last = content.at(-1);
      if (last?.type === "text") content[content.length - 1] = { ...last, text: last.text + delta };
      else content.push({ type: "text", text: delta });
      next[assistantIndex] = { ...assistant, content };
      return next;
    });
  }

  function appendThinking(): void {
    const description = "模型正在分析任务和已有结果。下方会展示实际执行的操作与结果；此处不展示原始内部推理文本。";
    setMessages((current) => {
      const assistantIndex = findStreamingAssistant(current);
      if (assistantIndex < 0) return current;
      const next = [...current];
      const assistant = next[assistantIndex]!;
      const content = [...assistant.content];
      const last = content.at(-1);
      if (last?.type === "thinking") {
        return current;
      } else {
        content.push({ type: "thinking", text: description });
      }
      next[assistantIndex] = { ...assistant, content };
      return next;
    });
  }

  function appendSystemMessage(message: string): void {
    setMessages((current) => [...current, {
      id: crypto.randomUUID(),
      role: "system",
      content: [{ type: "error", message }],
      timestamp: new Date().toISOString(),
    }]);
  }

  function updateActivity(id: string, patch: Partial<Activity>): void {
    setActivities((current) =>
      current.map((activity) => activity.id === id ? { ...activity, ...patch } : activity)
    );
    updateStreamingContent(content => content.map(block => block.type === "tool_use" && block.toolId === id ? {...block, ...(patch.status ? {status:patch.status} : {}), ...(patch.result !== undefined ? {result:patch.result} : {})} : block));
  }

  function updateStreamingContent(update: (content: DesktopContentBlock[]) => DesktopContentBlock[]): void {
    setMessages(current => {
      const index = findStreamingAssistant(current);
      return index < 0 ? current : current.map((message, i) => i === index ? {...message,content:update(message.content)} : message);
    });
  }

  async function chooseWorkspace(): Promise<string | null> {
    if (isRunning) {
      setNotice("请先停止当前任务，再更换项目目录");
      window.setTimeout(() => setNotice(""), 2200);
      return null;
    }
    const selected = await window.allycode.chooseWorkspace();
    if (!selected) return null;
    localStorage.setItem("allycode.cwd", selected);
    setCwd(selected);
    setSessionId(undefined);
    setTaskId(undefined);
    setMessages([]);
    setActivities([]);
    setWorkingPlan([]);
    stickToBottomRef.current = true;
    setShowScrollToBottom(false);
    await refreshTree(selected);
    await refreshTasks(selected);
    return selected;
  }

  async function activateBenchmarkWorkspace(workspace: string): Promise<void> {
    if (isRunning) throw new Error("请先停止当前任务，再切换到评测项目。");
    localStorage.setItem("allycode.cwd", workspace);
    setCwd(workspace);
    resetConversation();
    await Promise.all([refreshTree(workspace), refreshTasks(workspace)]);
  }

  function resetConversation(): void {
    setHistoryLoading(false);
    setWorkingPlan([]);
    setSteeringMessages([]);
    selectionEpochRef.current++;
    boundRunRef.current = undefined;
    startingRunRef.current = false;
    queuedEventsRef.current = [];
    setSessionId(undefined);
    setTaskId(undefined);
    setMessages([]);
    setActivities([]);
    setActivityOpen(false);
    setAgentPhase("idle");
    setRunStartedAt(undefined);
    setElapsedSeconds(0);
    setSessionMenu(undefined);
    stickToBottomRef.current = true;
    setShowScrollToBottom(false);
  }

  function startTaskInCurrentWorkspace(): void {
    resetConversation();
    setNewTaskOpen(false);
  }

  async function chooseWorkspaceForNewTask(): Promise<void> {
    const selected = await chooseWorkspace();
    if (selected) setNewTaskOpen(false);
  }

  async function openSession(session: SessionSummary): Promise<void> {
    if (isRunning) return;
    if (managingSessions) {
      toggleSelectedSession(session.id);
      return;
    }
    await openHistory(session.cwd, session.id);
  }

  async function openHistory(workspace: string, savedSessionId?: string, savedTaskId?: string): Promise<boolean> {
    setSessionMenu(undefined);
    boundRunRef.current = undefined;
    const epoch = ++selectionEpochRef.current;
    setHistoryLoading(true);
    try {
      const [history, workspaceTasks, workspaceTree] = await Promise.all([
        savedSessionId ? window.allycode.loadSession(savedSessionId) : Promise.resolve([]),
        window.allycode.listTasks(workspace),
        window.allycode.listWorkspace(workspace),
      ]);
      if (epoch !== selectionEpochRef.current) return false;
      const selectedTask = workspaceTasks.find(task => savedTaskId ? task.id === savedTaskId : task.sessionId === savedSessionId);
      setSessionId(savedSessionId);
      setTaskId(selectedTask?.id);
      const lastPlan = history.flatMap(message => message.content).filter(block => block.type === "plan").at(-1);
      setWorkingPlan(selectedTask?.plan?.length ? selectedTask.plan : lastPlan?.items ?? []);
      setDraft("");
      setSteeringMessages([]);
      setPermission(undefined);
      setCwd(workspace);
      localStorage.setItem("allycode.cwd", workspace);
      setTree(workspaceTree);
      setTasks(workspaceTasks);
      setMessages(history);
      setActivities(conversationTools(history).map((block,index) => ({id:`saved-${index}-${block.toolId}`,name:block.toolName,detail:summarize(block.input),status:block.status,result:block.result})));
      setAgentPhase("idle");
      stickToBottomRef.current = true;
      setShowScrollToBottom(false);
      return true;
    } catch (error) {
      if (epoch === selectionEpochRef.current) setNotice(`加载历史记录失败：${localizeError(String(error))}`);
      return false;
    } finally {
      if (epoch === selectionEpochRef.current) setHistoryLoading(false);
    }
  }

  async function exportSession(session: SessionSummary): Promise<void> {
    setSessionMenu(undefined);
    try {
      const result = await window.allycode.exportSession(session.id);
      if (result.canceled) return;
      setNotice(`会话已导出${result.filePath ? `：${result.filePath}` : ""}`);
      window.setTimeout(() => setNotice(""), 4200);
    } catch (error) {
      setNotice(localizeError(String(error)));
      window.setTimeout(() => setNotice(""), 3200);
    }
  }

  function toggleSelectedSession(id: string): void {
    setSelectedSessions((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function requestSessionDeletion(sessionIds: string[]): void {
    const unique = [...new Set(sessionIds)];
    const linkedTasks = allTasks.filter((task) =>
      task.sessionId && unique.includes(task.sessionId)
    );
    if (linkedTasks.some((task) =>
      task.status === "running" || task.status === "waiting_permission"
    )) {
      setNotice("运行中或等待确认的任务不能删除，请先暂停任务");
      window.setTimeout(() => setNotice(""), 2600);
      return;
    }
    setDeleteRequest({
      sessionIds: unique,
      includeDurableTasks: linkedTasks.length > 0,
    });
  }

  async function confirmSessionDeletion(): Promise<void> {
    if (!deleteRequest) return;
    setDeletingSessions(true);
    try {
      const result = await window.allycode.deleteSessions(deleteRequest);
      if (deleteRequest.sessionIds.includes(sessionId ?? "")) resetConversation();
      setDeleteRequest(undefined);
      setSelectedSessions(new Set());
      setManagingSessions(false);
      await refreshSessions();
      await refreshTasks(cwd || undefined);
      setNotice(
        `已删除 ${result.deletedSessionCount} 个会话` +
        (result.deletedTaskCount > 0
          ? `，并清除 ${result.deletedTaskCount} 个持久任务及 ${result.deletedEventCount} 条事件`
          : result.detachedTaskCount > 0
            ? `；${result.detachedTaskCount} 个持久任务已保留`
            : ""),
      );
      window.setTimeout(() => setNotice(""), 3200);
    } catch (error) {
      setNotice(localizeError(String(error)));
      window.setTimeout(() => setNotice(""), 3200);
    } finally {
      setDeletingSessions(false);
    }
  }

  function selectFinishedSessions(): void {
    const allowed = new Set(
      allTasks
        .filter((task) => task.sessionId && ["paused", "completed"].includes(task.status))
        .map((task) => task.sessionId!),
    );
    setSelectedSessions(new Set(sessions.filter((session) => allowed.has(session.id)).map((session) => session.id)));
  }

  async function openTask(task: TaskSummary): Promise<boolean> {
    if (isRunning) return false;
    return openHistory(task.cwd, task.sessionId, task.id);
  }

  async function resumeTask(task: TaskSummary): Promise<void> {
    if (isRunning || !task.resumable) return;
    if (!await openTask(task)) return;
    setMessages((current) => [...current, {
      id: crypto.randomUUID(),
      role: "assistant",
      content: task.plan?.length ? [{type:"plan",items:task.plan}] : [],
      timestamp: new Date().toISOString(),
      streaming: true,
    }]);
    setRunStartedAt(Date.now());
    setElapsedSeconds(0);
    setAgentPhase("waiting_model");
    try {
      startingRunRef.current = true;
      const started = await window.allycode.resumeTask(task.id).catch((error: unknown) => { startingRunRef.current = false; queuedEventsRef.current = []; throw error; });
      boundRunRef.current = started.runId;
      startingRunRef.current = false;
      setRunId(started.runId);
      setTaskId(started.taskId);
      queuedEventsRef.current.splice(0).forEach(handleAgentEvent);
    } catch (error) {
      appendSystemMessage(localizeError(String(error)));
      setMessages((current) => current.map((message) =>
        message.streaming ? { ...message, streaming: false } : message
      ));
      setAgentPhase("completed");
    }
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (historyLoading || startingRunRef.current) return;
    const prompt = draft.trim();
    if (!prompt || sendingSteering) return;
    if (isRunning && runId) {
      setSendingSteering(true);
      try {
        const accepted = await window.allycode.steerAgent(runId,prompt);
        setSteeringMessages(current=>current.some(item=>item.id===accepted.id)?current:[...current,{id:accepted.id,text:prompt,status:"queued"}]);
        setDraft(current=>current.trim()===prompt?"":current);
        setPermission(undefined);
      } catch(error) { setNotice(localizeError(String(error))); }
      finally {setSendingSteering(false);}
      return;
    }
    let workspace = cwd;
    if (!workspace) {
      workspace = await chooseWorkspace() ?? "";
      if (!workspace) {
        setNotice("请选择项目文件夹后再执行任务");
        window.setTimeout(() => setNotice(""), 2200);
        return;
      }
    }
    if (
      settings &&
      providerNeedsCredential(settings.provider) &&
      credentialStatus &&
      !credentialStatus[settings.provider]
    ) {
      setSettingsOpen(true);
      setNotice(`请先配置 ${providerLabel(settings.provider)} API 密钥`);
      window.setTimeout(() => setNotice(""), 2600);
      return;
    }
    const resumableTask = taskId
      ? [...tasks, ...allTasks].find((task) => task.id === taskId && task.resumable)
      : undefined;
    if (resumableTask && isResumeIntent(prompt)) {
      setDraft("");
      setNotice("已识别为恢复任务，将从最新检查点继续");
      window.setTimeout(() => setNotice(""), 2600);
      await resumeTask(resumableTask);
      return;
    }
    setDraft("");
    setWorkingPlan([]);
    setSteeringMessages([]);
    setRunStartedAt(Date.now());
    setElapsedSeconds(0);
    setAgentPhase("waiting_model");
    stickToBottomRef.current = true;
    setShowScrollToBottom(false);
    const now = new Date().toISOString();
    setMessages((current) => [...current, {
      id: crypto.randomUUID(),
      role: "user",
      content: [{ type: "text", text: prompt }],
      timestamp: now,
    }, {
      id: crypto.randomUUID(),
      role: "assistant",
      content: [],
      timestamp: now,
      streaming: true,
    }]);
    try {
      startingRunRef.current = true;
      const started = await window.allycode.startAgent({
        prompt,
        cwd: workspace,
        sessionId,
        taskId,
      }).catch((error: unknown) => { startingRunRef.current = false; queuedEventsRef.current = []; throw error; });
      boundRunRef.current = started.runId;
      startingRunRef.current = false;
      setRunId(started.runId);
      setTaskId(started.taskId);
      queuedEventsRef.current.splice(0).forEach(handleAgentEvent);
    } catch (error) {
      appendSystemMessage(localizeError(String(error)));
      setMessages((current) =>
        current.map((message) =>
          message.streaming ? { ...message, streaming: false } : message
        )
      );
      setAgentPhase("completed");
    }
  }

  async function continuePhase(toolId:string,optionId?:string):Promise<void> {
    if(!taskId || isRunning || historyLoading || startingRunRef.current) return;
    const sourceTaskId=taskId;
    startingRunRef.current=true;
    try {
      const started=await window.allycode.continuePhase(sourceTaskId,toolId,optionId);
      const fresh=started.taskId!==sourceTaskId;
      if(fresh) setSessionId(undefined);
      setMessages(current=>[...(fresh?[]:current),{id:crypto.randomUUID(),role:"user",content:[{type:"text",text:optionId?`选择方案 ${optionId}`:"根据已保存的交接记录开始下一阶段"}],timestamp:new Date().toISOString()},{id:crypto.randomUUID(),role:"assistant",content:[],timestamp:new Date().toISOString(),streaming:true}]);
      setWorkingPlan([]);setDraft("");setSteeringMessages([]);
      setRunStartedAt(Date.now());setElapsedSeconds(0);setAgentPhase("waiting_model");
      boundRunRef.current=started.runId;setRunId(started.runId);setTaskId(started.taskId);
      startingRunRef.current=false;queuedEventsRef.current.splice(0).forEach(handleAgentEvent);
    } catch(error) {startingRunRef.current=false;queuedEventsRef.current=[];appendSystemMessage(localizeError(String(error)));}
  }

  async function stop(): Promise<void> {
    if (runId) await window.allycode.abortAgent(runId);
    setRunId(undefined);
    setAgentPhase("completed");
  }

  async function resolvePermission(decision: "allow" | "deny" | "allow-session"): Promise<void> {
    if (!permission) return;
    await window.allycode.resolvePermission(permission.requestId, decision);
    setPermission(undefined);
  }

  async function saveSettings(next: AllyCodeSettings): Promise<void> {
    setSettings(await window.allycode.saveSettings(next));
    setCredentialStatus(await window.allycode.getCredentialStatus());
    setSettingsOpen(false);
    setNotice("模型与 API 设置已保存");
    window.setTimeout(() => setNotice(""), 1800);
  }

  async function saveCapabilitySettings(next: AllyCodeSettings): Promise<void> {
    setSettings(await window.allycode.saveSettings(next));
    setNotice("能力配置已保存，将在下一个任务生效");
    window.setTimeout(() => setNotice(""), 2200);
  }

  async function saveEngineSettings(next: AllyCodeSettings): Promise<void> {
    setSettings(await window.allycode.saveSettings(next));
    setEnginesOpen(false);
    setNotice("Agent 引擎设置已保存，将在下一个任务生效");
    window.setTimeout(() => setNotice(""), 2200);
  }

  const latestActivity = activities.at(-1);
  async function attachVision():Promise<void> {
    const workspace=cwd||await chooseWorkspace();if(!workspace)return;
    const epoch=selectionEpochRef.current;
    try {const files=await window.allycode.importVisionFiles(workspace);if(epoch!==selectionEpochRef.current||workspaceRef.current!==workspace)return;
      if(files.length)setDraft(current=>current+"\n请使用内置视觉分析以下项目内资料：\n"+files.map(file=>JSON.stringify(file)).join("\n"));
    }catch(error){appendSystemMessage(localizeError(String(error)));}
  }
  const emptyState = messages.length === 0;

  function renderComposer(className = ""): JSX.Element {
    return (
      <div className={`composer-wrap ${className}`.trim()}>
      {agentPhase !== "idle" && (
        <div className={`agent-phase ${agentPhase}`} role="status">
          <span />
          <strong>{agentPhaseLabel(agentPhase)}</strong>
          <small>
            {agentPhase === "waiting_model_after_tool" && "Agent 循环仍在继续 · "}
            {agentPhase === "completed" ? "本轮用时" : "已用时"} {formatElapsed(elapsedSeconds)}
          </small>
        </div>
      )}
      <form
        className="composer"
        onSubmit={(event) => void submit(event)}
      >
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={isRunning ? "随时补充要求或调整方向，在下一个安全步骤处理…" : "输入任务，例如：分析项目架构并修复当前问题…"}
          aria-label={isRunning ? "补充任务要求" : "输入任务"}
          maxLength={20000}
          rows={3}
        />
        <div className="composer-footer">
          <button type="button" className="attach-vision" title="选择图片或 PDF，复制到当前项目" aria-label="添加图片或 PDF" disabled={historyLoading} onClick={()=>void attachVision()}>＋ 图片/PDF</button>
          <span>
            {latestActivity?.status === "running"
              ? `正在执行：${toolLabel(latestActivity.name)}`
              : cwd
                ? "回车发送 · Shift+回车换行"
                : "可先输入任务，发送时会提示选择项目文件夹"}
          </span>
          {isRunning && (
            <button type="button" className="stop" title="暂停任务" aria-label="暂停任务" onClick={() => void stop()}>Ⅱ</button>
          )}
          <button type="submit" aria-label={isRunning?"发送补充":"发送任务"} disabled={!draft.trim() || sendingSteering || historyLoading}>{sendingSteering?"发送中":isRunning?"补充 ↑":"↑"}</button>
        </div>
      </form>
      </div>
    );
  }

  return (
    <div className={`app-shell ${activityOpen ? "activity-open" : ""}`}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">AC</div>
          <div><strong>AllyCode</strong><span title={BUILD_INFO.sourceHash}>{BUILD_INFO.version}</span></div>
        </div>

        <button className="new-chat" disabled={isRunning} onClick={() => setNewTaskOpen(true)}>
          <span>＋</span> 新建任务
        </button>

        <section className="sidebar-section workspace">
          <header>
            <span>项目</span>
            <button className="change-workspace" title="更换项目目录" onClick={() => void chooseWorkspace()}>更换目录</button>
          </header>
          <button className="workspace-name" onClick={() => void chooseWorkspace()}>
            <span className="folder">◆</span>
            <span>{projectName}</span>
          </button>
          {cwd && <div className="workspace-path project-path" title={cwd}>{cwd}</div>}
          <div className="file-tree">
            <Tree entries={tree} />
          </div>
        </section>

        {allTasks.some((task) => !["completed", "cancelled"].includes(task.status)) && (
          <section className="sidebar-section active-tasks">
            <header>
              <span>各项目待继续任务</span>
              <span>{allTasks.filter((task) => !["completed", "cancelled"].includes(task.status)).length}</span>
            </header>
            <div className="task-list">
              {allTasks
                .filter((task) => !["completed", "cancelled"].includes(task.status))
                .slice(0, 20)
                .map((task) => (
                  <div className={`task-row ${task.id === taskId ? "active" : ""}`} key={task.id}>
                    <button className="task-open" disabled={isRunning} title={task.cwd} onClick={() => void openTask(task)}>
                      <span>{task.title}</span>
                      <small className="project-path">{task.cwd}</small>
                      <small>{taskStatusLabel(task.status)}</small>
                    </button>
                    {task.resumable && (
                      <button className="task-resume" disabled={isRunning} onClick={() => void resumeTask(task)}>
                        继续
                      </button>
                    )}
                  </div>
                ))}
            </div>
          </section>
        )}

        <section className="sidebar-section sessions">
          <header>
            <span>最近会话</span>
            <button onClick={() => {
              setManagingSessions((value) => !value);
              setSelectedSessions(new Set());
            }}>{managingSessions ? "完成" : "管理"}</button>
          </header>
          {managingSessions && (
            <div className="session-manage-actions">
              <button onClick={selectFinishedSessions}>选择已暂停/已完成</button>
              <button
                disabled={selectedSessions.size === 0}
                onClick={() => requestSessionDeletion([...selectedSessions])}
              >删除已选 {selectedSessions.size || ""}</button>
            </div>
          )}
          <div className="session-list">
            {sessions.slice(0, 16).map((session) => (
              <div className={`session-row ${session.id === sessionId ? "active" : ""}`} key={session.id}>
                {managingSessions && (
                  <input
                    type="checkbox"
                    aria-label={`选择会话：${session.title}`}
                    checked={selectedSessions.has(session.id)}
                    onChange={() => toggleSelectedSession(session.id)}
                  />
                )}
                <button className="session-open" disabled={isRunning} title={session.cwd} onClick={() => void openSession(session)}>
                  <span>{session.title}</span>
                  <small>{relativeTime(session.updatedAt)}</small>
                  <small className="project-path">{session.cwd}</small>
                </button>
                {!managingSessions && (
                  <div className="session-actions">
                    <button
                      className="session-more"
                      title="会话操作"
                      aria-label={`会话操作：${session.title}`}
                      aria-haspopup="menu"
                      aria-expanded={sessionMenu?.id === session.id}
                      onClick={(event) => {
                        const rect = event.currentTarget.getBoundingClientRect();
                        setSessionMenu((current) => current?.id === session.id ? undefined : {
                          id: session.id,
                          top: Math.min(window.innerHeight - 86, rect.bottom + 4),
                          left: Math.max(8, rect.right - 132),
                        });
                      }}
                    >…</button>
                    {sessionMenu?.id === session.id && (
                      <div
                        className="session-menu"
                        role="menu"
                        style={{ top: sessionMenu.top, left: sessionMenu.left }}
                      >
                        <button role="menuitem" onClick={() => void exportSession(session)}>导出会话</button>
                        <button role="menuitem" onClick={() => {
                          setSessionMenu(undefined);
                          requestSessionDeletion([session.id]);
                        }}>删除会话</button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>

        <div className="sidebar-footer">
          <button onClick={() => setWorkbenchOpen(true)}><span className="sidebar-icon">▧</span><span><strong>工作台与能力安装</strong><small>环境 · 成果 · 版本恢复</small></span></button>
          <button onClick={() => setSetupOpen(true)}><span className="sidebar-icon">✓</span><span><strong>开始设置</strong><small>环境检测与一键准备</small></span></button>
          <button onClick={() => setAccountOpen(true)}><span className="sidebar-icon">＠</span><span><strong>邮箱注册／登录</strong><small>账号与本地使用</small></span></button>
          <button onClick={() => setEnginesOpen(true)}><span className="sidebar-icon">▣</span><span><strong>Agent 引擎</strong><small>{settings ? engineModeLabel(settings.agentEngine.mode) : "正在检测"}</small></span></button>
          <button onClick={() => setBenchmarkOpen(true)}><span className="sidebar-icon">▤</span><span><strong>评测实验室</strong><small>外部验收 · 不看自述</small></span></button>
          <button onClick={() => setSettingsOpen(true)}>
            <span className={`sidebar-status ${settings && credentialStatus?.[settings.provider] ? "" : "unconfigured"}`} />
            <span><strong>模型与 API</strong><small>{settings ? `${providerLabel(settings.provider)} · ${settings.model}` : "正在加载"}</small></span>
          </button>
          <button onClick={() => setCapabilitiesOpen(true)}><span className="sidebar-icon">◇</span><span><strong>Skills 与连接器</strong><small>工作流与 MCP 工具</small></span></button>
          <button onClick={() => setMonitorOpen(true)}><span className="sidebar-icon">◎</span><span><strong>Agent 检测台</strong><small>{taskId ? "实时诊断当前任务" : "开始任务后可观测"}</small></span></button>
          <button onClick={() => setSettingsOpen(true)}><span className="sidebar-icon">⚙</span><span><strong>应用设置</strong><small>安全、记忆与更新</small></span></button>
        </div>
      </aside>

      {workbenchOpen && <WorkbenchPanel cwd={cwd} running={isRunning} onClose={() => setWorkbenchOpen(false)} />}
      <main className="conversation">
        <header className="topbar">
          <div>
            <strong>{projectName}</strong>
            <span>{cwd || "输入任务，发送时选择项目文件夹"}</span>
          </div>
          <div className="topbar-actions">
            <button
              className="activity-toggle"
              onClick={() => void openMemory()}
            >
              项目记忆
            </button>
            <button
              className={`activity-toggle ${activityOpen ? "active" : ""}`}
              onClick={() => setActivityOpen((open) => !open)}
            >
              执行记录{activities.length > 0 ? ` ${activities.length}` : ""}
            </button>
          </div>
        </header>


        <div
          className={`messages ${emptyState ? "empty" : ""}`}
          ref={messagesRef}
          onScroll={handleMessageScroll}
        >
          {emptyState ? (
            <div className="welcome">
              <div className="welcome-mark">AC</div>
              <h1>希望 AllyCode 完成什么任务？</h1>
              <p>可直接输入需求。新建任务拥有独立记忆；重新打开历史任务可继续原来的工作。项目规则文件由同项目任务共同使用。</p>
              {cwd && (
                <div className="selected-workspace">
                  <div><span>当前项目目录</span><strong>{cwd}</strong></div>
                  <button onClick={() => void chooseWorkspace()}>更换目录</button>
                </div>
              )}
              {renderComposer("inline-composer")}
              <div className="welcome-actions">
                {!cwd && <button onClick={() => void chooseWorkspace()}>选择项目文件夹</button>}
                <button className="secondary" onClick={() => setSettingsOpen(true)}>
                  配置模型与 API
                </button>
              </div>
              <div className="suggestions">
                {["修复这个网站的按钮，并实际点击验证结果", "整理项目中的表格文件，生成可核对的统计报告", "制作客户登记与导出页面，验证填写、保存和导出"].map((text) => (
                  <button key={text} onClick={() => setDraft(text)}>{text}<span>↗</span></button>
                ))}
              </div>
            </div>
          ) : messages.map((message) => <Message key={message.id} message={message} onPhase={continuePhase} phaseEnabled={!isRunning && !historyLoading} latestPhaseToolId={conversationTools(messages).filter(block=>block.toolName==="phase_checkpoint"&&block.status==="success").at(-1)?.toolId} />)}
        {steeringMessages.length>0 && <div className="steering-receipts" aria-live="polite">{steeringMessages.map(item=><div key={item.id}><strong>{item.status==="applied"?"✓ 已加入后续步骤":"已收到，等待当前步骤结束"}</strong><span>{item.text}</span></div>)}</div>}
          {historyLoading && <p role="status">正在加载该项目的对话和执行记录…</p>}
        </div>

        {showScrollToBottom && (
          <button
            className="scroll-to-bottom"
            onClick={() => scrollMessagesToBottom()}
          >
            回到底部 ↓
          </button>
        )}

        {!emptyState && renderComposer()}
      </main>

      <aside className="activity-panel" aria-hidden={!activityOpen}>
        <header>
          <strong>执行记录</strong>
          <div><span>{activities.length}</span><button onClick={() => setActivityOpen(false)}>×</button></div>
        </header>
        {workingPlan.length > 0 && (
          <div className="working-plan">
            <strong>工作计划</strong>
            {workingPlan.map((item, index) => (
              <div className={item.status} key={`${index}-${item.step}`}>
                <span>{item.status === "completed" ? "✓" : item.status === "in_progress" ? "•" : "○"}</span>
                <p>{item.step}</p>
              </div>
            ))}
          </div>
        )}
        {activities.length === 0 && workingPlan.length === 0 ? (
          <div className="activity-empty">
            <span>◇</span>
            <p>工具调用、文件修改和命令输出会显示在这里。</p>
          </div>
        ) : (
          <div className="activity-list">
            {activities.map((activity) => <ActivityItem key={activity.id} activity={activity} />)}
          </div>
        )}
      </aside>

      {permission && <PermissionCard request={permission.request} cwd={cwd} onDecision={resolvePermission}/>}

      {newTaskOpen && (
        <div className="modal-backdrop">
          <div className="new-task-card">
            <header>
              <div><h2>新建任务</h2><p>请选择本次任务要操作的项目目录</p></div>
              <button aria-label="关闭" onClick={() => setNewTaskOpen(false)}>×</button>
            </header>
            {cwd ? (
              <div className="current-workspace-card">
                <span>当前项目目录</span>
                <strong>{cwd}</strong>
              </div>
            ) : (
              <div className="current-workspace-card empty">
                <span>尚未选择项目目录</span>
              </div>
            )}
            <p className="directory-help">Windows 目录选择器支持进入 D 盘、E 盘及其他本地磁盘位置。</p>
            <div className="modal-actions">
              <button onClick={() => setNewTaskOpen(false)}>取消</button>
              {cwd && <button onClick={startTaskInCurrentWorkspace}>使用当前目录</button>}
              <button className="primary" onClick={() => void chooseWorkspaceForNewTask()}>选择其他目录…</button>
            </div>
          </div>
        </div>
      )}

      {deleteRequest && (
        <div className="modal-backdrop">
          <div className="delete-session-card">
            <h2>永久删除所选会话？</h2>
            <p>将从本机物理删除 {deleteRequest.sessionIds.length} 个会话文件，此操作不可撤销。</p>
            <label className="delete-linked-option">
              <input
                type="checkbox"
                checked={deleteRequest.includeDurableTasks}
                onChange={(event) => setDeleteRequest({
                  ...deleteRequest,
                  includeDurableTasks: event.target.checked,
                })}
              />
              <span>
                <strong>同时删除关联持久任务</strong>
                <small>包括任务 checkpoint、执行事件日志和事件搜索索引；取消勾选会保留任务并解除会话关联。</small>
              </span>
            </label>
            <p className="memory-safe-note">项目长期记忆和其他会话不会被删除。</p>
            <div className="modal-actions">
              <button disabled={deletingSessions} onClick={() => setDeleteRequest(undefined)}>取消</button>
              <button className="primary" disabled={deletingSessions} onClick={() => void confirmSessionDeletion()}>
                {deletingSessions ? "正在删除…" : "确认永久删除"}
              </button>
            </div>
          </div>
        </div>
      )}

      {memoryOpen && memoryOverview && (
        <div className="modal-backdrop">
          <div className="memory-card">
            <header>
              <div>
                <h2>当前任务记忆</h2>
                <p>只显示当前任务会话的偏好、事实、决策和经验；新建任务不会继承这些内容。</p>
              </div>
              <button aria-label="关闭" onClick={() => setMemoryOpen(false)}>×</button>
            </header>
            <div className="memory-stats">
              <span>历史任务 <strong>{memoryOverview.taskCount}</strong></span>
              <span>可恢复任务 <strong>{memoryOverview.resumableTaskCount}</strong></span>
            </div>
            <div className="memory-sections">
              <MemorySection title="用户偏好" content={memoryOverview.user} />
              <MemorySection title="项目概况" content={memoryOverview.projectContext} />
              <MemorySection title="技术决策" content={memoryOverview.projectDecisions} />
              <MemorySection title="经验与问题" content={memoryOverview.projectLearnings} />
            </div>
            <div className="modal-actions">
              <button className="primary" onClick={() => setMemoryOpen(false)}>完成</button>
            </div>
          </div>
        </div>
      )}

      {settingsOpen && settings && (
        <SettingsModal
          settings={settings}
          credentialStatus={credentialStatus}
          onClose={() => setSettingsOpen(false)}
          onSave={saveSettings}
          updateState={updateState}
          onCheckUpdate={async () => setUpdateState(await window.allycode.checkForUpdates())}
          onDownloadUpdate={async () => setUpdateState(await window.allycode.downloadUpdate())}
        />
      )}
      {capabilitiesOpen && settings && (
        <CapabilityCenter
          settings={settings}
          onClose={() => setCapabilitiesOpen(false)}
          onSaveSettings={saveCapabilitySettings}
        />
      )}
      {enginesOpen && settings && (
        <AgentEngineCenter
          settings={settings}
          onClose={() => setEnginesOpen(false)}
          onSave={saveEngineSettings}
        />
      )}
      {benchmarkOpen && (
        <BenchmarkLab
          workspace={cwd}
          onClose={() => setBenchmarkOpen(false)}
          onActivate={activateBenchmarkWorkspace}
        />
      )}
      {monitorOpen && (
        <AgentMonitorConsole
          report={monitorReport}
          taskId={taskId}
          error={monitorError}
          onClose={() => setMonitorOpen(false)}
          onExport={async () => {
            if (!taskId) return;
            const result = await window.allycode.exportMonitorReport(taskId);
            if (!result.canceled) {
              setNotice(`脱敏诊断报告已导出：${result.filePath ?? ""}`);
              window.setTimeout(() => setNotice(""), 3200);
            }
          }}
        />
      )}
      {settings && !settings.onboarding.completed && !settingsOpen && (
        <FirstRunWizard
          settings={settings}
          onComplete={saveSettings}
          onAccount={()=>setAccountOpen(true)}
          onSetup={()=>setSetupOpen(true)}
        />
      )}
      {setupOpen&&<SetupPanel onClose={()=>setSetupOpen(false)} onModel={()=>{setSetupOpen(false);setSettingsOpen(true);}} onAccount={()=>setAccountOpen(true)}/>}
      {accountOpen&&<AccountPanel onClose={()=>setAccountOpen(false)}/>}
      {notice && <div className="toast">{notice}</div>}
    </div>
  );
}

function AgentMonitorConsole({
  report,
  taskId,
  error,
  onClose,
  onExport,
}: {
  report?: AgentMonitorReport;
  taskId?: string;
  error: string;
  onClose: () => void;
  onExport: () => Promise<void>;
}): JSX.Element {
  const measured = report?.scores.filter((score) => score.status === "measured") ?? [];
  const aggregate = measured.length
    ? Math.round(measured.reduce((sum, score) => sum + (score.score ?? 0), 0) / measured.length)
    : null;
  return (
    <div className="monitor-backdrop">
      <section className="monitor-console">
        <header>
          <div>
            <span className="monitor-live"><i /> 本地实时观测</span>
            <h2>Agent 检测台</h2>
            <p>{report ? `${report.task.title} · ${report.task.engine ?? "native"} · ${report.task.model ?? "模型待记录"}` : taskId ? "正在读取任务事件…" : "开始或打开一个任务后显示真实诊断"}</p>
          </div>
          <div className="monitor-actions"><button disabled={!report} onClick={() => void onExport()}>导出脱敏报告</button><button aria-label="关闭" onClick={onClose}>×</button></div>
        </header>
        {!taskId ? (
          <div className="monitor-empty"><span>◎</span><h3>暂无可监控任务</h3><p>先在项目中启动真实任务，再打开检测台。检测台不会主动调用模型或读取 API 密钥。</p></div>
        ) : error ? <div className="settings-error">{error}</div> : !report ? (
          <div className="monitor-empty"><p>正在构建实时诊断视图…</p></div>
        ) : (
          <div className="monitor-body">
            <div className="monitor-summary">
              <div className="monitor-grade"><strong>{aggregate ?? "—"}</strong><span>{aggregate === null ? "证据不足" : "已测维度均分"}</span></div>
              <div><small>状态</small><strong>{taskStatusLabel(report.task.status)}</strong></div>
              <div><small>工具</small><strong>{report.metrics.toolSuccesses}/{report.metrics.toolCalls}</strong></div>
              <div><small>告警</small><strong>{report.alerts.length}</strong></div>
              <div><small>模型轮次</small><strong>{report.metrics.modelTurns}</strong></div>
              <div><small>首次响应</small><strong>{report.metrics.firstSignalMs === null ? "—" : `${(report.metrics.firstSignalMs / 1000).toFixed(1)}s`}</strong></div>
              <div><small>独立失败</small><strong>{report.metrics.failureIncidents}</strong></div>
              <div><small>缓存读取</small><strong>{report.metrics.cacheReadTokens.toLocaleString()}</strong></div>
            </div>
            <div className="monitor-grid">
              <div className="monitor-column">
                <section className="monitor-section">
                  <header><strong>分项证据</strong><span>不以单一总分替代验收</span></header>
                  <div className="score-list">
                    {report.scores.map((score) => (
                      <div key={score.dimension}>
                        <span>{score.label}</span>
                        <div><i style={{ width: `${score.score ?? 0}%` }} /></div>
                        <strong>{score.score ?? "未评估"}</strong>
                        <small>{score.evidence}</small>
                      </div>
                    ))}
                  </div>
                </section>
                <section className="monitor-section">
                  <header><strong>规则告警</strong><span>{report.alerts.length}</span></header>
                  {report.alerts.length === 0 ? <div className="monitor-none">当前未触发确定性告警；这不代表业务逻辑已经通过。</div> : (
                    <div className="alert-list">{report.alerts.map((alert) => <div className={alert.severity} key={alert.id}><span>{alert.severity === "critical" ? "!" : "△"}</span><div><strong>{alert.title}</strong><p>{alert.detail}</p><small>证据事件：{alert.evidenceEventIds.join("、") || "无"}</small></div></div>)}</div>
                  )}
                </section>
              </div>
              <div className="monitor-column">
                <section className="monitor-section monitor-timeline-section">
                  <header><strong>实时事件</strong><span>最近 {report.timeline.length}</span></header>
                  <div className="monitor-timeline">{[...report.timeline].reverse().map((item) => <div className={item.severity} key={item.id}><i /><div><strong>{item.title}</strong><p>{item.detail}</p><small>#{item.id} · {new Date(item.createdAt).toLocaleTimeString("zh-CN", { hour12: false })}</small></div></div>)}</div>
                </section>
              </div>
            </div>
            <footer>完全本地 · 已分析 {report.metrics.analyzedEventCount.toLocaleString()} 条结构化事件 / 总计 {report.metrics.eventCount.toLocaleString()} 条 · 不记录隐藏思维 · 不导出密钥或完整工具输出 · 语义漂移需要结合需求与产物复审</footer>
          </div>
        )}
      </section>
    </div>
  );
}

function CapabilityCenter({
  settings,
  onClose,
  onSaveSettings,
}: {
  settings: AllyCodeSettings;
  onClose: () => void;
  onSaveSettings: (settings: AllyCodeSettings) => Promise<void>;
}): JSX.Element {
  const [tab, setTab] = useState<"skills" | "connectors">("skills");
  const [skills, setSkills] = useState<SkillDocument[]>([]);
  const [skillDraft, setSkillDraft] = useState<SkillDocument>();
  const [servers, setServers] = useState(() => structuredClone(settings.mcpServers));
  const [mcpResults, setMcpResults] = useState<MCPServerTestResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void window.allycode.listSkills().then(setSkills).catch((reason) => setError(localizeError(String(reason))));
  }, []);

  async function persistSkill(skill: SkillDocument): Promise<void> {
    setBusy(true);
    setError("");
    try {
      setSkills(await window.allycode.saveSkill(skill));
      setSkillDraft(undefined);
    } catch (reason) {
      setError(localizeError(String(reason)));
    } finally {
      setBusy(false);
    }
  }

  async function removeSkill(skill: SkillDocument): Promise<void> {
    if (!window.confirm(`确定删除 Skill“${skill.name}”吗？此操作不能撤销。`)) return;
    setSkills(await window.allycode.deleteSkill(skill.id));
  }

  function updateServer(index: number, patch: Partial<(typeof servers)[number]>): void {
    setMcpResults([]);
    setServers((current) => current.map((server, position) =>
      position === index ? { ...server, ...patch } : server
    ));
  }

  async function saveConnectors(): Promise<void> {
    setBusy(true);
    setError("");
    try {
      await onSaveSettings({ ...settings, mcpServers: servers });
    } catch (reason) {
      setError(localizeError(String(reason)));
    } finally {
      setBusy(false);
    }
  }

  async function testConnectors(): Promise<void> {
    setBusy(true);
    setError("");
    setMcpResults([]);
    try {
      setMcpResults(await window.allycode.testMcpServers(servers.filter((server) => server.enabled)));
    } catch (reason) {
      setError(localizeError(String(reason)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="capability-card">
        <header>
          <div><h2>Skill 与连接器</h2><p>把可复用工作流和外部工具接入真实 Agent 任务</p></div>
          <button aria-label="关闭" onClick={onClose}>×</button>
        </header>
        <div className="capability-tabs">
          <button className={tab === "skills" ? "active" : ""} onClick={() => setTab("skills")}>Skills <span>{skills.filter((skill) => skill.enabled).length}</span></button>
          <button className={tab === "connectors" ? "active" : ""} onClick={() => setTab("connectors")}>MCP 连接器 <span>{servers.filter((server) => server.enabled).length}</span></button>
        </div>
        {tab === "skills" ? (
          <div className="capability-content">
            <div className="capability-intro">
              <p>Skill 是按触发词自动启用的本地 Markdown 工作流。它增强执行规范，但不等于可执行插件。</p>
              <div><button onClick={() => setSkillDraft({ id: "", name: "", triggers: [], body: "", enabled: true })}>新建 Skill</button><button onClick={() => void window.allycode.openSkillsFolder()}>打开本地目录</button></div>
            </div>
            {skillDraft && (
              <div className="skill-editor">
                <div className="settings-inline-grid">
                  <label>标识（英文）<input disabled={skills.some((skill) => skill.id === skillDraft.id)} value={skillDraft.id} placeholder="code-review" onChange={(event) => setSkillDraft({ ...skillDraft, id: event.target.value })} /></label>
                  <label>名称<input value={skillDraft.name} placeholder="代码审查" onChange={(event) => setSkillDraft({ ...skillDraft, name: event.target.value })} /></label>
                </div>
                <label>触发词（用逗号分隔）<input value={skillDraft.triggers.join(", ")} placeholder="审查, review" onChange={(event) => setSkillDraft({ ...skillDraft, triggers: event.target.value.split(/[,，]/).map((item) => item.trim()).filter(Boolean) })} /></label>
                <label>工作流说明<textarea value={skillDraft.body} placeholder="说明 Agent 应按什么步骤完成任务……" onChange={(event) => setSkillDraft({ ...skillDraft, body: event.target.value })} /></label>
                <div className="inline-actions"><button onClick={() => setSkillDraft(undefined)}>取消</button><button className="primary" disabled={busy || !skillDraft.id || !skillDraft.name || !skillDraft.body} onClick={() => void persistSkill(skillDraft)}>保存 Skill</button></div>
              </div>
            )}
            <div className="skill-list">
              {skills.map((skill) => (
                <div className={`skill-row ${skill.enabled ? "" : "disabled"}`} key={skill.id}>
                  <div><strong>{skill.name}</strong><small>{skill.triggers.length ? `触发：${skill.triggers.join("、")}` : "始终启用"}</small></div>
                  <label className="compact-toggle"><input type="checkbox" checked={skill.enabled} onChange={(event) => void persistSkill({ ...skill, enabled: event.target.checked })} />启用</label>
                  <button onClick={() => setSkillDraft(structuredClone(skill))}>编辑</button>
                  <button onClick={() => void removeSkill(skill)}>删除</button>
                </div>
              ))}
              {skills.length === 0 && <div className="capability-empty">暂无 Skill。可以新建一个工作流或打开本地目录导入 Markdown。</div>}
            </div>
          </div>
        ) : (
          <div className="capability-content">
            <div className="capability-warning"><strong>实验性连接器</strong><span>stdio 会在宿主机启动第三方程序。只添加你信任的服务；未知写操作仍需逐次授权。</span></div>
            <div className="connector-list">
              {servers.map((server, index) => (
                <div className="connector-row" key={`${index}-${server.name}`}>
                  <div className="connector-heading">
                    <input value={server.name} aria-label="连接器名称" placeholder="连接器名称" onChange={(event) => updateServer(index, { name: event.target.value })} />
                    <select value={server.transport} onChange={(event) => updateServer(index, { transport: event.target.value as "stdio" | "http" })}><option value="http">HTTP</option><option value="stdio">本地 stdio</option></select>
                    <label className="compact-toggle"><input type="checkbox" checked={server.enabled} onChange={(event) => updateServer(index, { enabled: event.target.checked })} />启用</label>
                    <button aria-label="移除连接器" onClick={() => setServers((current) => current.filter((_, position) => position !== index))}>删除</button>
                  </div>
                  {server.transport === "http" ? (
                    <input value={server.url ?? ""} placeholder="https://example.com/mcp" onChange={(event) => updateServer(index, { url: event.target.value })} />
                  ) : (
                    <div className="settings-inline-grid"><input value={server.command ?? ""} placeholder="命令，例如 npx" onChange={(event) => updateServer(index, { command: event.target.value })} /><input value={(server.args ?? []).join(" ")} placeholder="参数（空格分隔）" onChange={(event) => updateServer(index, { args: event.target.value.split(/\s+/).filter(Boolean) })} /></div>
                  )}
                  {mcpResults.find((result) => result.name === server.name) && (() => {
                    const result = mcpResults.find((item) => item.name === server.name)!;
                    return <div className={`connector-result ${result.ok ? "passed" : "failed"}`}><strong>{result.ok ? `已连接 · ${result.toolCount} 个工具` : "连接失败"}</strong><span>{result.ok ? `${result.tools.join("、") || "服务未提供工具"} · ${result.latencyMs} ms` : result.error}</span></div>;
                  })()}
                </div>
              ))}
            </div>
            <button className="add-connector" onClick={() => setServers((current) => [...current, { name: `connector-${current.length + 1}`, enabled: true, transport: "http", url: "" }])}>＋ 添加 MCP 连接器</button>
            <small className="security-note">Alpha.9 不在界面保存连接器密钥。需要密钥的连接器暂时通过可信本地服务代理，正式插件密钥库将在后续版本完成。</small>
            <div className="inline-actions"><button disabled={busy || servers.every((server) => !server.enabled)} onClick={() => void testConnectors()}>{busy ? "正在连接…" : "测试已启用连接器"}</button><button className="primary" disabled={busy} onClick={() => void saveConnectors()}>保存连接器</button></div>
          </div>
        )}
        {error && <div className="settings-error">{error}</div>}
      </div>
    </div>
  );
}

function MemorySection({ title, content }: { title: string; content: string }): JSX.Element {
  return (
    <section>
      <strong>{title}</strong>
      <p>{content || "尚未形成相关长期记忆。完成更多真实任务后会在这里逐步沉淀。"}</p>
    </section>
  );
}

function Message({ message,onPhase,phaseEnabled,latestPhaseToolId }: { message: DesktopMessage;onPhase:(toolId:string,optionId?:string)=>Promise<void>;phaseEnabled:boolean;latestPhaseToolId?:string }): JSX.Element {
  return (
    <article className={`message ${message.role}`}>
      <div className="avatar">{message.role === "user" ? "我" : message.role === "assistant" ? "AC" : "!"}</div>
      <div className="message-body">
        <header>{message.role === "assistant" ? "AllyCode" : message.role === "user" ? "你" : "系统"}</header>
        {message.content.map((block, index) => {
          if (block.type === "text") return <TextContent key={index} text={block.text} />;
          if (block.type === "thinking") return <details key={index}><summary>执行说明</summary><p>{block.text}</p></details>;
          if (block.type === "plan") return <TaskPlan key={index} items={block.items} running={Boolean(message.streaming)}/>;
          if (block.type === "tool_use") {
            if(block.toolName==="phase_checkpoint"&&block.status==="success") {
              const parsed=PhaseCheckpointSchema.safeParse(block.input);
              if(parsed.success) return <section className="task-plan" key={index} aria-label="阶段选择"><strong>{parsed.data.title}</strong><p>{parsed.data.kind==="decision"?"请选择方案，或在输入框补充修改意见。":"本阶段已保存；下一阶段可使用独立对话与清单。"}</p><div className="inline-actions">{parsed.data.kind==="decision"?parsed.data.options.map(option=><button key={option.id} title={option.tradeoff} disabled={!phaseEnabled||block.toolId!==latestPhaseToolId} onClick={()=>void onPhase(block.toolId,option.id)}>选择 {option.id} · {option.title}</button>):<button disabled={!phaseEnabled||block.toolId!==latestPhaseToolId} onClick={()=>void onPhase(block.toolId)}>新阶段对话继续</button>}</div></section>;
            }
            if (block.toolName === "plan_update" && block.status !== "error" && block.status !== "denied") return null;
            const input = (block.input && typeof block.input === "object" ? block.input : {}) as Record<string, unknown>;
            const label = block.toolName === "bash" ? presentPermission({toolName:block.toolName,input,riskLevel:"safe",description:""},"").title : toolLabel(block.toolName);
            const target = [input.path, input.url, input.query, input.pattern, input.name].find(value => typeof value === "string") as string | undefined;
            const status = {pending:message.streaming ? "准备执行" : "未取得结果",running:message.streaming ? "正在执行" : "未取得结果",success:"已完成",error:"执行失败",denied:"未执行"}[block.status];
            return <details className={`inline-operation ${block.status}`} key={index}>
              <summary><span>{block.status === "success" ? "✓" : block.status === "error" || block.status === "denied" ? "!" : "○"}</span><strong>{label}</strong><small>{status}</small>{target && <span className="operation-target">{target}</span>}</summary>
              <p>操作参数</p><pre>{JSON.stringify(block.input,null,2)}</pre>
              {block.result !== undefined && <><p>执行结果（保留工具原文）</p><pre>{block.result}</pre></>}
            </details>;
          }
          if (block.type === "error") return <div className="error-block" key={index}>{block.message}</div>;
          return null;
        })}
        {message.streaming && !message.content.some(block => block.type === "plan") && <TaskPlan items={[]} running/>}
      </div>
    </article>
  );
}

function TextContent({ text }: { text: string }): JSX.Element {
  const parts = text.split(/(```[\s\S]*?```)/g);
  return (
    <>
      {parts.map((part, index) => part.startsWith("```")
        ? <pre className="code-block" key={index}>{part.replace(/^```\w*\n?|\n?```$/g, "")}</pre>
        : <p key={index}>{part}</p>
      )}
    </>
  );
}

function Tree({ entries, depth = 0 }: { entries: WorkspaceEntry[]; depth?: number }): JSX.Element {
  return (
    <>
      {entries.map((entry) => (
        <div key={entry.path}>
          <div className="tree-row" style={{ paddingLeft: 8 + depth * 12 }}>
            <span>{entry.type === "directory" ? "▾" : "·"}</span>
            <span>{entry.name}</span>
          </div>
          {entry.children && <Tree entries={entry.children} depth={depth + 1} />}
        </div>
      ))}
    </>
  );
}

function ActivityItem({ activity }: { activity: Activity }): JSX.Element {
  const [open, setOpen] = useState(activity.status === "running" || activity.status === "pending");
  return (
    <button className="activity-item" onClick={() => setOpen(!open)}>
      <div>
        <span className={`activity-icon ${activity.status}`}>
          {activity.status === "running" ? "◌" : activity.status === "pending" ? "·" : activity.status === "success" ? "✓" : "!"}
        </span>
        <div><strong>{toolLabel(activity.name)}</strong><span>{activity.detail}</span></div>
        <span>{open ? "⌃" : "⌄"}</span>
      </div>
      {open && activity.result && <pre>{activity.result}</pre>}
    </button>
  );
}

function AgentEngineCenter({
  settings,
  onClose,
  onSave,
}: {
  settings: AllyCodeSettings;
  onClose: () => void;
  onSave: (settings: AllyCodeSettings) => Promise<void>;
}): JSX.Element {
  const [draft, setDraft] = useState(() => structuredClone(settings));
  const [engines, setEngines] = useState<AgentEngineHealth[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function inspect(): Promise<void> {
    setLoading(true);
    setError("");
    try {
      setEngines(await window.allycode.inspectAgentEngines());
    } catch (inspectionError) {
      setError(localizeError(String(inspectionError)));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void inspect();
  }, []);

  async function submit(): Promise<void> {
    setSaving(true);
    setError("");
    try {
      await onSave(draft);
    } catch (saveError) {
      setError(localizeError(String(saveError)));
      setSaving(false);
    }
  }

  const selected = draft.agentEngine.mode;
  return (
    <div className="modal-backdrop">
      <section className="engine-card">
        <header>
          <div><h2>Agent 引擎</h2><p>模型决定思考能力；Agent 引擎决定如何使用工具、沙箱、记忆与执行流程。</p></div>
          <button aria-label="关闭" onClick={onClose}>×</button>
        </header>
        <div className="engine-mode-note">
          <strong>推荐：自动（原生引擎）</strong>
          <span>DeepSeek V4 等供应商 API 由原生引擎直接调用；Codex 使用自己的账号与模型配置。</span>
        </div>
        <label className={`engine-row ${selected === "auto" ? "selected" : ""}`}>
          <input
            type="radio"
            name="engine"
            checked={selected === "auto"}
            onChange={() => setDraft({ ...draft, agentEngine: { ...draft.agentEngine, mode: "auto" } })}
          />
          <div><strong>自动选择</strong><p>当前固定选择已验证的 AllyCode 原生引擎，不会静默切换外部运行时。</p></div>
          <span className="engine-state ready">推荐</span>
        </label>
        <div className="engine-list">
          {engines.map((health) => (
            <label className={`engine-row ${selected === health.engine.id ? "selected" : ""} ${health.selectable ? "" : "disabled"}`} key={health.engine.id}>
              <input
                type="radio"
                name="engine"
                checked={selected === health.engine.id}
                disabled={!health.selectable}
                onChange={() => setDraft({ ...draft, agentEngine: { ...draft.agentEngine, mode: health.engine.id } })}
              />
              <div>
                <strong>{health.engine.name}<small>{maturityLabel(health.engine.maturity)}</small></strong>
                <p>{health.engine.summary}</p>
                <small>{health.detail}{health.version ? ` · ${health.version}` : ""}</small>
              </div>
              <span className={`engine-state ${health.state}`}>{engineHealthLabel(health.state)}</span>
            </label>
          ))}
          {loading && <div className="engine-loading">正在检测本机运行时、版本与登录状态…</div>}
        </div>
        <label className="engine-fallback">
          <span><strong>不可用时回退到原生引擎</strong><small>回退原因会写入检测台，不会无痕切换。</small></span>
          <input
            type="checkbox"
            checked={draft.agentEngine.fallbackToNative}
            onChange={(event) => setDraft({ ...draft, agentEngine: { ...draft.agentEngine, fallbackToNative: event.target.checked } })}
          />
        </label>
        {error && <div className="settings-error">{error}</div>}
        <footer>
          <button onClick={() => void inspect()} disabled={loading}>{loading ? "检测中…" : "重新检测"}</button>
          <div><button onClick={onClose}>取消</button><button className="primary" disabled={saving} onClick={() => void submit()}>{saving ? "保存中…" : "保存"}</button></div>
        </footer>
      </section>
    </div>
  );
}

function BenchmarkLab({
  workspace,
  onClose,
  onActivate,
}: {
  workspace: string;
  onClose: () => void;
  onActivate: (workspace: string) => Promise<void>;
}): JSX.Element {
  const [state, setState] = useState<BenchmarkLabState>();
  const [report, setReport] = useState<BenchmarkRunReport>();
  const [busy, setBusy] = useState<"loading" | "preparing" | "running">("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    void window.allycode.getBenchmarkLab(workspace || undefined)
      .then((next) => {
        setState(next);
        setReport(next.latest);
        setBusy("loading");
      })
      .catch((loadError) => {
        setError(localizeError(String(loadError)));
        setBusy("loading");
      });
  }, [workspace]);

  async function prepare(): Promise<void> {
    setBusy("preparing");
    setError("");
    try {
      const result = await window.allycode.prepareBenchmarkWorkspace();
      if (result.workspace) await onActivate(result.workspace);
      if (!result.canceled && result.workspace) {
        setState(await window.allycode.getBenchmarkLab(result.workspace));
      }
    } catch (prepareError) {
      setError(localizeError(String(prepareError)));
    } finally {
      setBusy("loading");
    }
  }

  async function run(): Promise<void> {
    if (!workspace) return;
    setBusy("running");
    setError("");
    try {
      setReport(await window.allycode.runBenchmark(workspace));
    } catch (runError) {
      setError(localizeError(String(runError)));
    } finally {
      setBusy("loading");
    }
  }

  const isLoading = !state;
  return (
    <div className="monitor-backdrop">
      <section className="benchmark-card">
        <header>
          <div><span>ALPHA.11 · 独立证据</span><h2>评测实验室</h2><p>{state?.description ?? "正在读取固定挑战与验收器…"}</p></div>
          <button aria-label="关闭" onClick={onClose}>×</button>
        </header>
        <div className="benchmark-layout">
          <section>
            <div className="benchmark-title"><div><strong>{state?.title ?? "Binary Market Protocol 工业级盲测"}</strong><small>真实需求改编 · 外部评分 · 可复跑</small></div><span>100 分</span></div>
            <div className="benchmark-workspace">
              <span>当前测试目录</span>
              <strong>{workspace || "尚未创建评测项目"}</strong>
              <p>创建时只复制需求与初始骨架；隐藏断言保留在 AllyCode 安装目录外部执行。</p>
            </div>
            <div className="benchmark-actions">
              <button disabled={busy !== "loading"} onClick={() => void prepare()}>{busy === "preparing" ? "正在创建…" : "创建全新挑战项目"}</button>
              <button className="primary" disabled={!workspace || busy !== "loading"} onClick={() => void run()}>{busy === "running" ? "验收运行中…" : "运行独立验收"}</button>
            </div>
            {error && <div className="settings-error">{error}</div>}
            {isLoading && <div className="engine-loading">正在初始化评测实验室…</div>}
            {report && (
              <div className="benchmark-report">
                <div className="benchmark-score"><strong>{report.score}</strong><span>/ {report.total}</span><small>{new Date(report.generatedAt).toLocaleString("zh-CN")}</small></div>
                <div className="benchmark-results">
                  {report.results.map((item) => (
                    <div key={item.id}><span>{item.passed ? "✓" : "×"}</span><div><strong>{item.section} · {item.id}</strong><small>{item.detail}</small></div><b>{item.earned}/{item.points}</b></div>
                  ))}
                </div>
              </div>
            )}
          </section>
          <aside>
            <strong>评测纪律</strong>
            {(state?.principles ?? []).map((principle, index) => <p key={principle}><span>{index + 1}</span>{principle}</p>)}
            <div><strong>正确测试顺序</strong><small>创建挑战 → 在主会话运行固定提示词 → Agent 自主交付 → 运行独立验收 → 导出检测台报告。</small></div>
          </aside>
        </div>
      </section>
    </div>
  );
}

function SettingsModal({
  settings,
  credentialStatus,
  onClose,
  onSave,
  updateState,
  onCheckUpdate,
  onDownloadUpdate,
}: {
  settings: AllyCodeSettings;
  credentialStatus: ProviderCredentialStatus | null;
  onClose: () => void;
  onSave: (settings: AllyCodeSettings) => Promise<void>;
  updateState?: UpdateState;
  onCheckUpdate: () => Promise<void>;
  onDownloadUpdate: () => Promise<void>;
}): JSX.Element {
  const [draft, setDraft] = useState(() => structuredClone(settings));
  const [credential, setCredential] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ProviderTestResult>();
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogResult | undefined>(() =>
    fallbackCatalogForSettings(settings)
  );
  const [loadingModels, setLoadingModels] = useState(false);
  const modelRequestSequence = useRef(0);
  const [error, setError] = useState("");
  const providers = Object.keys(PROVIDER_NAMES) as AllyCodeSettings["provider"][];
  const currentCredentialConfigured =
    credential.length > 0 ||
    Boolean(credentialStatus?.[draft.provider]);
  const selectedCatalogModel = modelCatalog?.models.find((model) => model.id === draft.model);

  useEffect(() => {
    setModelCatalog(fallbackCatalogForSettings(draft));
    setTestResult(undefined);
    return () => { modelRequestSequence.current += 1; };
    // Network discovery is explicit: it may consume credentials and should not
    // fire merely because a settings dialog was opened or a key was typed.
  }, [draft.provider]);

  async function submitSettings(): Promise<void> {
    setSaving(true);
    setError("");
    try {
      const next = structuredClone(draft);
      if (credential) setProviderCredential(next, credential);
      await onSave(next);
    } catch (saveError) {
      setError(localizeError(String(saveError)));
      setSaving(false);
    }
  }

  async function testConnection(): Promise<void> {
    setTesting(true);
    setError("");
    setTestResult(undefined);
    try {
      const candidate = structuredClone(draft);
      if (credential) setProviderCredential(candidate, credential);
      setTestResult(await window.allycode.testProvider(candidate));
    } catch (testError) {
      setError(localizeError(String(testError)));
    } finally {
      setTesting(false);
    }
  }

  async function refreshModels(): Promise<void> {
    const sequence = ++modelRequestSequence.current;
    setLoadingModels(true);
    try {
      const candidate = structuredClone(draft);
      if (credential) setProviderCredential(candidate, credential);
      const catalog = await window.allycode.listProviderModels(candidate);
      if (sequence === modelRequestSequence.current) setModelCatalog(catalog);
    } catch (catalogError) {
      if (sequence === modelRequestSequence.current) {
        setModelCatalog(undefined);
        setError(localizeError(String(catalogError)));
      }
    } finally {
      if (sequence === modelRequestSequence.current) setLoadingModels(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <form className="settings-card" onSubmit={(event) => {
        event.preventDefault();
        void submitSettings();
      }}>
        <header><div><h2>模型与 API</h2><p>配置模型供应商、模型名称和执行安全选项</p></div><button type="button" aria-label="关闭" onClick={onClose}>×</button></header>
        <div className={`credential-status ${currentCredentialConfigured ? "configured" : "unconfigured"}`}>
          <span />
          {draft.provider === "ollama"
            ? "本地模型无需 API 密钥"
            : currentCredentialConfigured
              ? "当前供应商已配置，可直接开始任务"
              : "当前供应商尚未配置 API 密钥"}
        </div>
        <VisionPanel />
        <label>模型供应商
          <select
            value={draft.provider}
            onChange={(event) => {
              const provider = event.target.value as AllyCodeSettings["provider"];
              setCredential("");
              setTestResult(undefined);
              setModelCatalog(undefined);
              setDraft({
                ...draft,
                provider,
                model: DEFAULT_MODELS[provider],
                providerProtocol: "auto",
              });
            }}
          >
            {providers.map((provider) => (
              <option key={provider} value={provider}>{providerLabel(provider)}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="settings-label-heading">
            <span>模型名称</span>
            <button
              type="button"
              disabled={loadingModels}
              onClick={() => void refreshModels()}
            >{loadingModels ? "读取中…" : "刷新模型列表"}</button>
          </span>
          <input
            list="allycode-provider-models"
            value={draft.model}
            placeholder="输入该供应商支持的模型名称"
            onChange={(event) => {
              setTestResult(undefined);
              setDraft({ ...draft, model: event.target.value });
            }}
          />
          <datalist id="allycode-provider-models">
            {modelCatalog?.models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.verification === "official"
                  ? "官方能力已登记"
                  : model.source === "live"
                    ? "当前账户可见，能力待测试"
                    : "本地候选，尚未确认"}
              </option>
            ))}
          </datalist>
          {modelCatalog?.warning && <small className="model-catalog-warning">{modelCatalog.warning}</small>}
          {selectedCatalogModel && (
            <small className="model-capability-note">
              {modelCapabilitySummary(selectedCatalogModel)}
            </small>
          )}
          {testResult?.fieldErrors.model && <small className="field-error">{testResult.fieldErrors.model}</small>}
        </label>
        <label>API 传输协议
          <select
            value={draft.providerProtocol}
            onChange={(event) => {
              setTestResult(undefined);
              setDraft({
                ...draft,
                providerProtocol: event.target.value as AllyCodeSettings["providerProtocol"],
              });
            }}
          >
            {protocolOptionsForProvider(draft.provider).map((protocol) => (
              <option key={protocol} value={protocol}>{PROTOCOL_NAMES[protocol]}</option>
            ))}
          </select>
          <small>{protocolHelp(draft.provider, draft.providerProtocol)}</small>
        </label>
        {(draft.provider === "deepseek" || draft.provider === "openai" || draft.provider === "custom") && (
          <div className="settings-inline-grid">
            <label>思考模式
              <select
                value={draft.reasoning.mode}
                onChange={(event) => {
                  setTestResult(undefined);
                  setDraft({
                    ...draft,
                    reasoning: {
                      ...draft.reasoning,
                      mode: event.target.value as AllyCodeSettings["reasoning"]["mode"],
                    },
                  });
                }}
              >
                <option value="auto">自动（推荐）</option>
                <option value="enabled">开启</option>
                <option value="disabled">关闭</option>
              </select>
            </label>
            <label>思考强度
              <select
                value={draft.reasoning.effort}
                onChange={(event) => {
                  setTestResult(undefined);
                  setDraft({
                    ...draft,
                    reasoning: {
                      ...draft.reasoning,
                      effort: event.target.value as AllyCodeSettings["reasoning"]["effort"],
                    },
                  });
                }}
              >
                <option value="auto">自动（推荐）</option>
                <option value="low">低</option>
                <option value="medium">中</option>
                <option value="high">高</option>
                <option value="max">最高</option>
                {draft.provider === "openai" && <option value="xhigh">超高</option>}
              </select>
            </label>
          </div>
        )}
        {draft.provider !== "ollama" && (
          <label>{draft.provider === "custom" ? "端点 API 密钥（可选）" : "API 密钥"}
            <input
              type="password"
              autoComplete="off"
              value={credential}
              placeholder={currentCredentialConfigured ? "已安全保存；留空则保持不变" : "请输入 API 密钥"}
              onChange={(event) => {
                setCredential(event.target.value);
                setTestResult(undefined);
                setModelCatalog(undefined);
              }}
            />
            {testResult?.fieldErrors.credential && <small className="field-error">{testResult.fieldErrors.credential}</small>}
          </label>
        )}
        {draft.provider === "custom" && (
          <label>OpenAI 兼容接口地址
            <input
              value={draft.customProviderUrl ?? ""}
              placeholder="https://example.com/v1"
              onChange={(event) => {
                setTestResult(undefined);
                setModelCatalog(undefined);
                setDraft({ ...draft, customProviderUrl: event.target.value });
              }}
            />
            {testResult?.fieldErrors.baseUrl && <small className="field-error">{testResult.fieldErrors.baseUrl}</small>}
          </label>
        )}
        {draft.provider !== "custom" && (
          <label>接口地址覆盖（可选）
            <input
              value={draft.providerBaseUrls[draft.provider] ?? ""}
              placeholder={PROVIDER_BASE_URLS[draft.provider] ?? "留空使用内置官方地址"}
              onChange={(event) => {
                const providerBaseUrls = { ...draft.providerBaseUrls };
                if (event.target.value) providerBaseUrls[draft.provider] = event.target.value;
                else delete providerBaseUrls[draft.provider];
                setTestResult(undefined);
                setModelCatalog(undefined);
                setDraft({ ...draft, providerBaseUrls });
              }}
            />
            <small>适用于地域端点、国内网关或企业代理；留空使用内置地址。</small>
          </label>
        )}
        <label>最大输出 Token 数
          <input type="number" min={1024} max={384000} value={draft.maxTokens} onChange={(event) => setDraft({ ...draft, maxTokens: Number(event.target.value) })} />
        </label>
        <label>每阶段模型轮次上限
          <input type="number" min={1} max={200} value={draft.executionBudget.maxModelTurnsPerRun} onChange={(event) => setDraft({ ...draft, executionBudget: { ...draft.executionBudget, maxModelTurnsPerRun: Number(event.target.value) } })} />
          <small>达到上限保存进度；在原任务继续下一阶段，保留历史与计划。</small>
        </label>
        <label>每阶段工具调用上限
          <input type="number" min={1} max={2000} value={draft.executionBudget.maxToolCallsPerRun} onChange={(event) => setDraft({ ...draft, executionBudget: { ...draft.executionBudget, maxToolCallsPerRun: Number(event.target.value) } })} />
        </label>
        <label className="toggle-row">
          <span><strong>启用任务累计预算</strong><small>默认关闭，长任务可以分阶段持续推进；费用统计仍累计保存。</small></span>
          <input type="checkbox" checked={draft.executionBudget.enforceTaskLimits} onChange={(event) => setDraft({ ...draft, executionBudget: { ...draft.executionBudget, enforceTaskLimits: event.target.checked } })} />
        </label>
        {draft.executionBudget.enforceTaskLimits && <><label>任务累计模型轮次上限
          <input type="number" min={1} max={500} value={draft.executionBudget.maxModelTurnsPerTask} onChange={(event) => setDraft({ ...draft, executionBudget: { ...draft.executionBudget, maxModelTurnsPerTask: Number(event.target.value) } })} />
        </label><label>任务累计工具调用上限
          <input type="number" min={1} max={2000} value={draft.executionBudget.maxToolCallsPerTask} onChange={(event) => setDraft({ ...draft, executionBudget: { ...draft.executionBudget, maxToolCallsPerTask: Number(event.target.value) } })} />
        </label></>}
        <label className="toggle-row">
          <span><strong>Docker 沙箱</strong><small>在隔离容器中执行终端命令</small></span>
          <input type="checkbox" checked={draft.sandbox.enabled} onChange={(event) => setDraft({ ...draft, sandbox: { ...draft.sandbox, enabled: event.target.checked } })} />
        </label>
        <section className="update-settings">
          <div>
            <strong>软件更新</strong>
            <small>当前版本 {updateState?.currentVersion ?? "0.11.0-alpha.5"} · 国内主源与备用源</small>
          </div>
          <p>{updateState?.message ?? "可手动检查新版本；不会在后台自动下载。"}</p>
          {updateState?.status === "downloading" && (
            <progress max={100} value={updateState.progress ?? 0} />
          )}
          <div className="update-actions">
            {updateState?.status === "available" && (
              <button type="button" onClick={() => void onDownloadUpdate()}>下载更新</button>
            )}
            {updateState?.status === "downloaded" ? (
              <button type="button" onClick={() => void window.allycode.installUpdate()}>重启并安装</button>
            ) : (
              <button
                type="button"
                disabled={updateState?.status === "checking" || updateState?.status === "downloading"}
                onClick={() => void onCheckUpdate()}
              >检查更新</button>
            )}
          </div>
        </section>
        <label className="toggle-row">
          <span><strong>语义记忆</strong><small>在不同会话中检索与当前任务相关的上下文</small></span>
          <input type="checkbox" checked={draft.memory.semanticRetrieval} onChange={(event) => setDraft({ ...draft, memory: { ...draft.memory, semanticRetrieval: event.target.checked } })} />
        </label>
        {error && <div className="settings-error">{error}</div>}
        {testResult && (
          <div className={`provider-test-result ${testResult.ok ? "passed" : "failed"}`}>
            <strong>{testResult.ok ? "兼容性测试通过" : "兼容性测试未通过"}</strong>
            <p>
              能力等级：{capabilityLevelLabel(testResult.capability.level)} ·
              协议：{PROTOCOL_NAMES[testResult.capability.protocol] ?? "未知"}
            </p>
            {testResult.stages.map((stage) => (
              <div key={stage.stage}>
                <span>{stage.ok ? "✓" : "×"}</span>
                <b>{providerStageLabel(stage.stage)}</b>
                <small>{stage.message}{stage.latencyMs === undefined ? "" : ` · ${stage.latencyMs} ms`}</small>
              </div>
            ))}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>取消</button>
          <button type="button" disabled={testing || saving || !draft.model.trim()} onClick={() => void testConnection()}>
            {testing ? "正在真实测试…" : "测试连接与工具调用"}
          </button>
          <button className="primary" type="submit" disabled={saving || !draft.model.trim()}>
            {saving ? "正在保存…" : "保存设置"}
          </button>
        </div>
      </form>
    </div>
  );
}

function FirstRunWizard({
  settings,
  onComplete,
  onAccount,
  onSetup,
}: {
  settings: AllyCodeSettings;
  onComplete: (settings: AllyCodeSettings) => Promise<void>;
  onAccount:()=>void;
  onSetup:()=>void;
}): JSX.Element {
  const domesticProviders = ["deepseek", "qwen", "moonshot"] as const;
  const initialProvider = domesticProviders.includes(settings.provider as typeof domesticProviders[number])
    ? settings.provider as typeof domesticProviders[number]
    : "deepseek";
  const [draft, setDraft] = useState<AllyCodeSettings>({
    ...structuredClone(settings),
    provider: initialProvider,
    model: DEFAULT_MODELS[initialProvider],
  });
  const [step, setStep] = useState(1);
  const [credential, setCredential] = useState("");
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<ProviderTestResult>();
  const [error, setError] = useState("");

  async function verifyAndFinish(): Promise<void> {
    setStep(3);
    setTesting(true);
    setError("");
    const candidate = structuredClone(draft);
    setProviderCredential(candidate, credential);
    try {
      const test = await window.allycode.testProvider(candidate);
      setResult(test);
      if (!test.ok) return;
      setSaving(true);
      candidate.onboarding = {
        ...candidate.onboarding,
        completed: true,
        completedAt: new Date().toISOString(),
        region: "cn",
      };
      await onComplete(candidate);
    } catch (failure) {
      setError(localizeError(String(failure)));
    } finally {
      setTesting(false);
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop onboarding-backdrop">
      <div className="onboarding-card">
        <div className="onboarding-brand"><span>AC</span><strong>欢迎使用 AllyCode</strong></div>
        <div className="onboarding-progress" aria-label={`第 ${step} 步，共 3 步`}>
          {[1, 2, 3].map((item) => <i key={item} className={item <= step ? "active" : ""} />)}
        </div>

        {step === 1 && (
          <>
            <h1>选择一个国内模型服务</h1>
            <p>先连接模型即可开始。文档与视觉组件可通过“开始设置”自动检测和安装。</p>
            <div className="modal-actions"><button onClick={onAccount}>邮箱注册／登录</button><button onClick={onSetup}>检测这台电脑</button></div>
            <div className="provider-choice-grid">
              {domesticProviders.map((provider) => (
                <button
                  type="button"
                  className={draft.provider === provider ? "selected" : ""}
                  key={provider}
                  onClick={() => setDraft({
                    ...draft,
                    provider,
                    model: DEFAULT_MODELS[provider],
                    providerProtocol: "auto",
                  })}
                >
                  <strong>{providerLabel(provider)}</strong>
                  <small>{provider === "deepseek" ? "默认使用 DeepSeek V4 Pro，支持完整 Agent 工具续接" : provider === "qwen" ? "阿里云百炼模型服务" : "月之暗面 Kimi API"}</small>
                </button>
              ))}
            </div>
            <div className="modal-actions"><button onClick={()=>void onComplete({...settings,onboarding:{...settings.onboarding,completed:true,completedAt:new Date().toISOString()}}).catch(e=>setError(String(e)))}>先进入工作区，稍后配置</button><button className="primary" onClick={() => setStep(2)}>下一步</button></div>
          </>
        )}

        {step === 2 && (
          <>
            <h1>配置 {providerLabel(draft.provider)} API 密钥</h1>
            <p>密钥使用操作系统安全密钥库保存在本机。Linux 需启用 GNOME Keyring 或兼容密钥库；验证连接会调用所选模型，可能产生少量费用。</p>
            <label>API 密钥
              <input
                autoFocus
                type="password"
                autoComplete="off"
                value={credential}
                placeholder="粘贴模型厂商提供的 API 密钥"
                onChange={(event) => setCredential(event.target.value)}
              />
            </label>
            <button className="provider-console-link" onClick={() => void window.allycode.openProviderConsole(draft.provider)}>
              打开官方 API 密钥申请页面 ↗
            </button>
            <div className="modal-actions">
              <button onClick={() => setStep(1)}>上一步</button>
              <button className="primary" disabled={!credential.trim()} onClick={() => void verifyAndFinish()}>验证并完成</button>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <h1>{testing ? "正在验证真实连接…" : result?.ok ? "连接成功" : "连接未通过"}</h1>
            <p>{testing ? "正在检查密钥、模型响应与工具调用兼容性。" : result?.ok ? "设置已验证，正在进入 AllyCode。" : "请根据下面的结果检查后重试。"}</p>
            {result && (
              <div className={`provider-test-result ${result.ok ? "passed" : "failed"}`}>
                {result.stages.map((stage) => (
                  <div key={stage.stage}><span>{stage.ok ? "✓" : "×"}</span><b>{providerStageLabel(stage.stage)}</b><small>{stage.message}</small></div>
                ))}
              </div>
            )}
            {error && <div className="settings-error">{error}</div>}
            {!testing && !saving && !result?.ok && (
              <div className="modal-actions"><button onClick={() => setStep(2)}>返回修改</button><button className="primary" onClick={() => void verifyAndFinish()}>重新验证</button></div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function findStreamingAssistant(messages: DesktopMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "assistant" && messages[index]?.streaming) return index;
  }
  return -1;
}

function summarize(value: unknown): string {
  if (typeof value === "string") return value.length > 90 ? `${value.slice(0, 87)}…` : value;
  try {
    const text = JSON.stringify(value, null, 2);
    return text.length > 240 ? `${text.slice(0, 237)}…` : text;
  } catch {
    return String(value);
  }
}

function relativeTime(value: string): string {
  const elapsed = Date.now() - new Date(value).getTime();
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}

function taskStatusLabel(status: TaskSummary["status"]): string {
  const labels: Record<TaskSummary["status"], string> = {
    queued: "等待开始",
    running: "正在执行",
    waiting_permission: "等待确认",
    paused: "已暂停，可继续",
    completed: "已完成",
    failed: "执行失败",
    cancelled: "已取消",
  };
  return labels[status];
}

function agentPhaseLabel(phase: AgentDisplayPhase): string {
  const labels: Record<AgentDisplayPhase, string> = {
    idle: "就绪",
    waiting_model: "正在连接模型…",
    thinking: "正在思考…",
    streaming: "模型正在输出…",
    tool_running: "正在执行工具…",
    waiting_model_after_tool: "工具已完成，正在继续思考…",
    completed: "本轮任务已结束",
  };
  return labels[phase];
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${seconds % 60} 秒`;
}

function engineModeLabel(mode: AgentEngineMode): string {
  return {
    auto: "自动 · 原生",
    native: "AllyCode 原生",
    codex: "Codex",
    "deepseek-harness": "DeepSeek Harness",
  }[mode];
}

function engineHealthLabel(state: AgentEngineHealth["state"]): string {
  return {
    ready: "可用",
    not_installed: "未安装",
    needs_auth: "需要登录",
    incompatible: "协议待适配",
    unavailable: "不可用",
  }[state];
}

function maturityLabel(maturity: AgentEngineHealth["engine"]["maturity"]): string {
  return {
    stable: "稳定",
    beta: "测试版",
    "developer-preview": "开发预览",
  }[maturity];
}

const PROVIDER_NAMES: Record<AllyCodeSettings["provider"], string> = {
  deepseek: "DeepSeek（国内推荐）",
  qwen: "阿里云通义千问 / Qwen（国内）",
  moonshot: "月之暗面 / Kimi（国内）",
  anthropic: "Anthropic",
  openai: "OpenAI",
  groq: "Groq",
  gemini: "Google Gemini",
  ollama: "Ollama 本地模型",
  openrouter: "OpenRouter",
  custom: "自定义兼容接口",
};

const DEFAULT_MODELS: Record<AllyCodeSettings["provider"], string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4o",
  deepseek: "deepseek-v4-pro",
  qwen: "qwen3-coder-plus",
  groq: "llama-3.3-70b-versatile",
  gemini: "gemini-2.0-flash",
  ollama: "qwen2.5-coder:7b",
  openrouter: "anthropic/claude-sonnet-4",
  moonshot: "kimi-k3",
  custom: "gpt-4o",
};

const PROTOCOL_NAMES: Record<AllyCodeSettings["providerProtocol"] | "unknown", string> = {
  auto: "自动选择（推荐）",
  anthropic: "Anthropic Messages",
  chat_completions: "Chat Completions",
  responses: "Responses API",
  unknown: "未知",
};

function protocolOptionsForProvider(
  provider: AllyCodeSettings["provider"],
): AllyCodeSettings["providerProtocol"][] {
  if (provider === "anthropic") return ["auto", "anthropic"];
  if (provider === "openai" || provider === "custom") {
    return ["auto", "responses", "chat_completions"];
  }
  return ["auto", "chat_completions"];
}

function protocolHelp(
  provider: AllyCodeSettings["provider"],
  protocol: AllyCodeSettings["providerProtocol"],
): string {
  if (provider === "deepseek") {
    return "DeepSeek V4 官方直连使用 Chat Completions；工具调用后的思考状态会原样续接。";
  }
  if (provider === "openai" && protocol === "auto") {
    return "OpenAI 自动使用 Responses API，并以无状态方式续传推理与工具调用项。";
  }
  if (provider === "custom") {
    return "请选择该网关真实实现的协议；错误协议不会自动伪装兼容。";
  }
  return "自动模式只选择 AllyCode 已实现并验证过的供应商协议。";
}

function capabilityLevelLabel(level: ProviderTestResult["capability"]["level"]): string {
  return {
    unavailable: "不可用",
    chat_only: "仅基础对话",
    tool_call_only: "仅首轮工具调用",
    agent_ready: "Agent 两轮验证通过",
  }[level];
}

function modelCapabilitySummary(
  model: ModelCatalogResult["models"][number],
): string {
  if (model.verification !== "official") {
    return model.source === "live"
      ? "该模型已由供应商列表返回，但工具、思考与视觉能力尚未验证；请运行下方兼容性测试。"
      : "该模型来自内置或手工候选，当前账户可用性及 Agent 能力尚未验证。";
  }
  const context = model.capabilities.contextWindow
    ? `${Math.round(model.capabilities.contextWindow / 1_000_000)}M 上下文`
    : "上下文规格未登记";
  const output = model.capabilities.maxOutputTokens
    ? `最高 ${Math.round(model.capabilities.maxOutputTokens / 1_000)}K 输出`
    : "输出上限未登记";
  return `官方能力登记：${context} · ${output} · 原生工具调用 · 思考模式；是否可用于当前账户仍以两轮实测为准。`;
}

function fallbackCatalogForSettings(settings: AllyCodeSettings): ModelCatalogResult | undefined {
  if (settings.provider !== "deepseek") return undefined;
  return {
    provider: "deepseek",
    retrieval: "fallback",
    fetchedAt: new Date().toISOString(),
    models: ["deepseek-v4-flash", "deepseek-v4-pro"].map((id) => ({
      id,
      provider: "deepseek" as const,
      source: "fallback" as const,
      verification: "official" as const,
      protocols: ["chat_completions" as const, "anthropic" as const],
      capabilities: {
        protocol: "chat_completions" as const,
        streaming: true,
        toolCalls: "native" as const,
        reasoning: "supported" as const,
        vision: "unverified" as const,
        contextWindow: 1_000_000,
        maxOutputTokens: 384_000,
        source: "official" as const,
        notes: [],
      },
    })),
  };
}

const PROVIDER_BASE_URLS: Partial<Record<AllyCodeSettings["provider"], string>> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com/v1",
  qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  groq: "https://api.groq.com/openai/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai/",
  ollama: "http://127.0.0.1:11434",
  openrouter: "https://openrouter.ai/api/v1",
  moonshot: "https://api.moonshot.cn/v1",
};

function providerStageLabel(stage: ProviderTestResult["stages"][number]["stage"]): string {
  if (stage === "tool_result_roundtrip") return "工具结果续接";
  return {
    configuration: "配置",
    model_discovery: "模型发现",
    chat: "基础对话",
    tool_call: "工具调用",
  }[stage];
}

function providerLabel(provider: AllyCodeSettings["provider"]): string {
  return PROVIDER_NAMES[provider];
}

function providerNeedsCredential(
  provider: AllyCodeSettings["provider"],
): boolean {
  return provider !== "ollama" && provider !== "custom";
}

function toolLabel(name: string): string {
  const labels: Record<string, string> = {
    bash: "执行终端命令",
    file_read: "读取文件",
    file_write: "写入文件",
    file_edit: "编辑文件",
    glob: "查找文件",
    grep: "搜索代码",
    web_fetch: "读取网页",
    web_search: "搜索网络",
    git_commit: "提交 Git 变更",
    spawn_research: "执行深度研究",
    plan_update: "更新任务计划",
    sources_to_excel: "整理资料并生成 Excel",
    document_ocr: "本地识别图片与扫描件",
    document_format: "按规范生成和转换 Word/PDF",
    document_verify: "校验 Word 格式与关键内容",
    vision_analyze: "本地视觉理解与资料识别",
    phase_checkpoint: "保存阶段与等待确认",
    verification_status: "核对工程验证证据",
    browser_verify: "验证浏览器页面",
    service_start: "启动项目服务",
    service_stop: "停止项目服务",
    service_status: "检查服务状态",
    desktop_control: "操作桌面应用",
  };
  return labels[name] ?? name;
}

function localizeError(message: string): string {
  if (/\b402\b|insufficient balance/i.test(message)) {
    return "模型 API 账户余额不足。密钥已经连接成功，但供应商拒绝继续计费；请充值或更换有余额的 API Key 后重试。";
  }
  if (/\b401\b|invalid api key|unauthorized/i.test(message)) {
    return "模型 API 密钥无效或已失效。请打开“模型与 API”重新检查密钥。";
  }
  if (/\b403\b|forbidden/i.test(message)) {
    return "当前 API 账户没有调用该模型或接口的权限，请检查供应商控制台中的模型权限。";
  }
  if (/\b429\b|rate limit/i.test(message)) {
    return "模型 API 已达到速率或额度限制，请稍后重试或检查供应商限额。";
  }
  if (/API key not set/i.test(message)) {
    return "当前模型供应商尚未配置 API 密钥。请打开“模型与 API”完成配置。";
  }
  if (/No local model service found/i.test(message)) {
    return "未发现本地模型服务。请启动 Ollama，或在“模型与 API”中配置本地服务地址。";
  }
  if (/requires customProviderUrl/i.test(message)) {
    return "自定义模型供应商缺少接口地址，请在“模型与 API”中填写。";
  }
  if (/aborted|aborterror/i.test(message)) return "任务已停止。";
  return message.replace(/^Error:\s*/i, "");
}

function setProviderCredential(settings: AllyCodeSettings, credential: string): void {
  switch (settings.provider) {
    case "anthropic": settings.apiKey = credential; break;
    case "openai": settings.openaiApiKey = credential; break;
    case "deepseek": settings.deepseekApiKey = credential; break;
    case "qwen": settings.qwenApiKey = credential; break;
    case "groq": settings.groqApiKey = credential; break;
    case "gemini": settings.geminiApiKey = credential; break;
    case "openrouter": settings.openrouterApiKey = credential; break;
    case "moonshot": settings.moonshotApiKey = credential; break;
    case "custom": settings.customProviderKey = credential; break;
    case "ollama": break;
  }
}
