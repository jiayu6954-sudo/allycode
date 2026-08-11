import { FormEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AllyCodeSettings } from "../../../src/config/schema.js";
import type { PermissionRequest } from "../../../src/types/permissions.js";
import type { AgentPhase } from "../../../src/types/agent.js";
import type { ProviderTestResult } from "../../../src/providers/diagnostics.js";
import type {
  DesktopAgentEvent,
  DeleteSessionsRequest,
  DesktopMessage,
  MemoryOverview,
  ProviderCredentialStatus,
  SessionSummary,
  TaskSummary,
  UpdateState,
  WorkspaceEntry,
} from "../../shared.js";

interface Activity {
  id: string;
  name: string;
  detail: string;
  status: "pending" | "running" | "success" | "error" | "denied";
  result?: string;
}

type AgentDisplayPhase = AgentPhase | "idle" | "thinking";

export function App(): JSX.Element {
  const [settings, setSettings] = useState<AllyCodeSettings | null>(null);
  const [credentialStatus, setCredentialStatus] =
    useState<ProviderCredentialStatus | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [allTasks, setAllTasks] = useState<TaskSummary[]>([]);
  const [sessionId, setSessionId] = useState<string>();
  const [taskId, setTaskId] = useState<string>();
  const [cwd, setCwd] = useState(localStorage.getItem("allycode.cwd") ?? "");
  const [tree, setTree] = useState<WorkspaceEntry[]>([]);
  const [messages, setMessages] = useState<DesktopMessage[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [draft, setDraft] = useState("");
  const [runId, setRunId] = useState<string>();
  const [permission, setPermission] = useState<{
    requestId: string;
    request: PermissionRequest;
  }>();
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [memoryOverview, setMemoryOverview] = useState<MemoryOverview>();
  const [settingsOpen, setSettingsOpen] = useState(false);
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
    setTasks(await window.allycode.listTasks(workspace));
  }

  async function refreshTree(workspace: string): Promise<void> {
    setTree(await window.allycode.listWorkspace(workspace));
  }

  async function openMemory(): Promise<void> {
    if (!cwd) {
      setNotice("请先选择项目目录，再查看项目记忆");
      window.setTimeout(() => setNotice(""), 2200);
      return;
    }
    setMemoryOverview(await window.allycode.getMemoryOverview(cwd));
    setMemoryOpen(true);
  }

  function handleAgentEvent(payload: DesktopAgentEvent): void {
    if ("event" in payload) {
      const event = payload.event;
      if (event.type === "status") setAgentPhase(event.phase);
      else if (event.type === "text_delta") {
        setAgentPhase("streaming");
        appendAssistantText(event.delta);
      } else if (event.type === "thinking_delta") {
        setAgentPhase("thinking");
        appendThinking(event.delta);
      }
      else if (event.type === "tool_pending") {
        setActivityOpen(true);
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
      } else if (event.type === "error") {
        appendSystemMessage(localizeError(event.error.message));
      }
      return;
    }
    if (payload.type === "permission") {
      setPermission({ requestId: payload.requestId, request: payload.request });
    } else if (payload.type === "task_status") {
      setTaskId(payload.task.id);
      setTasks((current) => [
        payload.task,
        ...current.filter((task) => task.id !== payload.task.id),
      ]);
      setAllTasks((current) => [
        payload.task,
        ...current.filter((task) => task.id !== payload.task.id),
      ]);
    } else if (payload.type === "complete") {
      setSessionId(payload.sessionId);
      setTaskId(payload.taskId);
      setMessages((current) =>
        current.map((message) => message.streaming ? { ...message, streaming: false } : message)
      );
      setRunId(undefined);
      setAgentPhase("completed");
      void refreshSessions();
      void refreshTasks(cwd || undefined);
    } else if (payload.type === "paused") {
      setSessionId(payload.sessionId);
      setTaskId(payload.taskId);
      setMessages((current) =>
        current.map((message) => message.streaming ? { ...message, streaming: false } : message)
      );
      setRunId(undefined);
      setAgentPhase("completed");
      setNotice("任务已暂停，执行状态和对话检查点已保存");
      window.setTimeout(() => setNotice(""), 2600);
      void refreshSessions();
      void refreshTasks(cwd || undefined);
    } else if (payload.type === "fatal") {
      appendSystemMessage(localizeError(payload.message));
      setMessages((current) =>
        current.map((message) => message.streaming ? { ...message, streaming: false } : message)
      );
      setRunId(undefined);
      setAgentPhase("completed");
      void refreshTasks(cwd || undefined);
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

  function appendThinking(delta: string): void {
    setMessages((current) => {
      const assistantIndex = findStreamingAssistant(current);
      if (assistantIndex < 0) return current;
      const next = [...current];
      const assistant = next[assistantIndex]!;
      const content = [...assistant.content];
      const last = content.at(-1);
      if (last?.type === "thinking") {
        content[content.length - 1] = { ...last, text: last.text + delta };
      } else {
        content.push({ type: "thinking", text: delta });
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
    stickToBottomRef.current = true;
    setShowScrollToBottom(false);
    await refreshTree(selected);
    await refreshTasks(selected);
    return selected;
  }

  function resetConversation(): void {
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
    if (managingSessions) {
      toggleSelectedSession(session.id);
      return;
    }
    setSessionMenu(undefined);
    setSessionId(session.id);
    const matchingTask = (await window.allycode.listTasks(session.cwd))
      .find((task) => task.sessionId === session.id);
    setTaskId(matchingTask?.id);
    setCwd(session.cwd);
    localStorage.setItem("allycode.cwd", session.cwd);
    stickToBottomRef.current = true;
    setShowScrollToBottom(false);
    setMessages(await window.allycode.loadSession(session.id));
    setActivities([]);
    await refreshTree(session.cwd);
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

  async function openTask(task: TaskSummary): Promise<void> {
    setTaskId(task.id);
    setCwd(task.cwd);
    localStorage.setItem("allycode.cwd", task.cwd);
    stickToBottomRef.current = true;
    setShowScrollToBottom(false);
    setSessionId(task.sessionId);
    setMessages(task.sessionId ? await window.allycode.loadSession(task.sessionId) : []);
    setActivities([]);
    await Promise.all([refreshTree(task.cwd), refreshTasks(task.cwd)]);
  }

  async function resumeTask(task: TaskSummary): Promise<void> {
    if (isRunning || !task.resumable) return;
    await openTask(task);
    setMessages((current) => [...current, {
      id: crypto.randomUUID(),
      role: "assistant",
      content: [],
      timestamp: new Date().toISOString(),
      streaming: true,
    }]);
    setRunStartedAt(Date.now());
    setElapsedSeconds(0);
    setAgentPhase("waiting_model");
    try {
      const started = await window.allycode.resumeTask(task.id);
      setRunId(started.runId);
      setTaskId(started.taskId);
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
    const prompt = draft.trim();
    if (!prompt || isRunning) return;
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
    setDraft("");
    setActivities([]);
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
      const started = await window.allycode.startAgent({
        prompt,
        cwd: workspace,
        sessionId,
        taskId,
      });
      setRunId(started.runId);
      setTaskId(started.taskId);
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

  const latestActivity = activities.at(-1);
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
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder="输入任务，例如：分析项目架构并修复当前问题…"
          disabled={isRunning}
          rows={3}
        />
        <div className="composer-footer">
          <span>
            {latestActivity?.status === "running"
              ? `正在执行：${toolLabel(latestActivity.name)}`
              : cwd
                ? "回车发送 · Shift+回车换行"
                : "可先输入任务，发送时会提示选择项目文件夹"}
          </span>
          {isRunning ? (
            <button type="button" className="stop" title="暂停任务" aria-label="暂停任务" onClick={() => void stop()}>Ⅱ</button>
          ) : (
            <button type="submit" disabled={!draft.trim()}>↑</button>
          )}
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
          <div><strong>AllyCode</strong><span>智能编程助手</span></div>
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
          <div className="file-tree">
            <Tree entries={tree} />
          </div>
        </section>

        {tasks.some((task) => !["completed", "cancelled"].includes(task.status)) && (
          <section className="sidebar-section active-tasks">
            <header>
              <span>进行中的任务</span>
              <span>{tasks.filter((task) => !["completed", "cancelled"].includes(task.status)).length}</span>
            </header>
            <div className="task-list">
              {tasks
                .filter((task) => !["completed", "cancelled"].includes(task.status))
                .slice(0, 6)
                .map((task) => (
                  <div className={`task-row ${task.id === taskId ? "active" : ""}`} key={task.id}>
                    <button className="task-open" onClick={() => void openTask(task)}>
                      <span>{task.title}</span>
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
                <button className="session-open" onClick={() => void openSession(session)}>
                  <span>{session.title}</span>
                  <small>{relativeTime(session.updatedAt)}</small>
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

        <button className="settings-button" onClick={() => setSettingsOpen(true)}>
          <span>⚙</span> 设置
        </button>
      </aside>

      <main className="conversation">
        <header className="topbar">
          <div>
            <strong>{projectName}</strong>
            <span>{cwd || "输入任务，发送时选择项目文件夹"}</span>
          </div>
          <div className="topbar-actions">
            <button
              className="model-pill"
              onClick={() => setSettingsOpen(true)}
              title="切换模型供应商、模型和 API 密钥"
            >
              <span className={`status-dot ${
                settings && credentialStatus?.[settings.provider] ? "" : "unconfigured"
              }`} />
              <span>
                <small>模型与 API</small>
                <strong>
                  {settings ? providerLabel(settings.provider) : "加载中"}
                  {" · "}
                  {settings?.model ?? "未配置"}
                </strong>
              </span>
              <b>设置</b>
            </button>
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
              <p>可直接输入需求。AllyCode 会理解项目、在授权后执行工具，并在不同会话中保留相关项目记忆。</p>
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
                {["分析并说明这个项目", "查找并修复失败的测试", "规划并实现一个新功能"].map((text) => (
                  <button key={text} onClick={() => setDraft(text)}>{text}<span>↗</span></button>
                ))}
              </div>
            </div>
          ) : messages.map((message) => <Message key={message.id} message={message} />)}
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
        {activities.length === 0 ? (
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

      {permission && (
        <div className="modal-backdrop">
          <div className="permission-card">
            <span className={`risk ${permission.request.riskLevel}`}>{riskLabel(permission.request.riskLevel)}</span>
            <h2>是否允许执行此操作？</h2>
            <p className="permission-reason">{permissionReason(permission.request)}</p>
            <p>{permission.request.description}</p>
            <pre>{summarize(permission.request.input)}</pre>
            <div className="modal-actions">
              <button onClick={() => void resolvePermission("deny")}>拒绝</button>
              {permission.request.riskLevel !== "dangerous" && (
                <button onClick={() => void resolvePermission("allow-session")}>本次会话允许同类操作</button>
              )}
              <button className="primary" onClick={() => void resolvePermission("allow")}>仅允许一次</button>
            </div>
          </div>
        </div>
      )}

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
                <h2>项目记忆</h2>
                <p>AllyCode 在本地保存的用户偏好、项目事实、技术决策和解决经验</p>
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
      {settings && !settings.onboarding.completed && (
        <FirstRunWizard
          settings={settings}
          onComplete={saveSettings}
        />
      )}
      {notice && <div className="toast">{notice}</div>}
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

function Message({ message }: { message: DesktopMessage }): JSX.Element {
  return (
    <article className={`message ${message.role}`}>
      <div className="avatar">{message.role === "user" ? "我" : message.role === "assistant" ? "AC" : "!"}</div>
      <div className="message-body">
        <header>{message.role === "assistant" ? "AllyCode" : message.role === "user" ? "你" : "系统"}</header>
        {message.content.map((block, index) => {
          if (block.type === "text") return <TextContent key={index} text={block.text} />;
          if (block.type === "thinking") return <details key={index}><summary>思考过程</summary><p>{block.text}</p></details>;
          if (block.type === "error") return <div className="error-block" key={index}>{block.message}</div>;
          return null;
        })}
        {message.streaming && message.content.length === 0 && <div className="typing"><i /><i /><i /></div>}
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
  const [error, setError] = useState("");
  const providers = Object.keys(PROVIDER_NAMES) as AllyCodeSettings["provider"][];
  const currentCredentialConfigured =
    credential.length > 0 ||
    Boolean(credentialStatus?.[draft.provider]);

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
        <label>模型供应商
          <select
            value={draft.provider}
            onChange={(event) => {
              const provider = event.target.value as AllyCodeSettings["provider"];
              setCredential("");
              setTestResult(undefined);
              setDraft({
                ...draft,
                provider,
                model: DEFAULT_MODELS[provider],
              });
            }}
          >
            {providers.map((provider) => (
              <option key={provider} value={provider}>{providerLabel(provider)}</option>
            ))}
          </select>
        </label>
        <label>模型名称
          <input
            value={draft.model}
            placeholder="输入该供应商支持的模型名称"
            onChange={(event) => setDraft({ ...draft, model: event.target.value })}
          />
          {testResult?.fieldErrors.model && <small className="field-error">{testResult.fieldErrors.model}</small>}
        </label>
        {draft.provider !== "ollama" && (
          <label>{draft.provider === "custom" ? "端点 API 密钥（可选）" : "API 密钥"}
            <input
              type="password"
              autoComplete="off"
              value={credential}
              placeholder={currentCredentialConfigured ? "已安全保存；留空则保持不变" : "请输入 API 密钥"}
              onChange={(event) => setCredential(event.target.value)}
            />
            {testResult?.fieldErrors.credential && <small className="field-error">{testResult.fieldErrors.credential}</small>}
          </label>
        )}
        {draft.provider === "custom" && (
          <label>OpenAI 兼容接口地址
            <input
              value={draft.customProviderUrl ?? ""}
              placeholder="https://example.com/v1"
              onChange={(event) => setDraft({ ...draft, customProviderUrl: event.target.value })}
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
                setDraft({ ...draft, providerBaseUrls });
              }}
            />
            <small>适用于地域端点、国内网关或企业代理；留空使用内置地址。</small>
          </label>
        )}
        <label>最大输出 Token 数
          <input type="number" min={1024} max={128000} value={draft.maxTokens} onChange={(event) => setDraft({ ...draft, maxTokens: Number(event.target.value) })} />
        </label>
        <label className="toggle-row">
          <span><strong>Docker 沙箱</strong><small>在隔离容器中执行终端命令</small></span>
          <input type="checkbox" checked={draft.sandbox.enabled} onChange={(event) => setDraft({ ...draft, sandbox: { ...draft.sandbox, enabled: event.target.checked } })} />
        </label>
        <section className="update-settings">
          <div>
            <strong>软件更新</strong>
            <small>当前版本 {updateState?.currentVersion ?? "0.10.0-alpha.8"} · 国内主源与备用源</small>
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
}: {
  settings: AllyCodeSettings;
  onComplete: (settings: AllyCodeSettings) => Promise<void>;
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
            <p>无需配置开发环境。只需从模型厂商申请 API 密钥，即可开始使用。</p>
            <div className="provider-choice-grid">
              {domesticProviders.map((provider) => (
                <button
                  type="button"
                  className={draft.provider === provider ? "selected" : ""}
                  key={provider}
                  onClick={() => setDraft({ ...draft, provider, model: DEFAULT_MODELS[provider] })}
                >
                  <strong>{providerLabel(provider)}</strong>
                  <small>{provider === "deepseek" ? "默认推荐，接入简单" : provider === "qwen" ? "阿里云百炼模型服务" : "月之暗面 Kimi API"}</small>
                </button>
              ))}
            </div>
            <div className="modal-actions"><button className="primary" onClick={() => setStep(2)}>下一步</button></div>
          </>
        )}

        {step === 2 && (
          <>
            <h1>配置 {providerLabel(draft.provider)} API 密钥</h1>
            <p>密钥只会使用 Windows 系统加密保存在本机，界面和配置文件都不会读取到明文。</p>
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
  deepseek: "deepseek-chat",
  qwen: "qwen3-coder-plus",
  groq: "llama-3.3-70b-versatile",
  gemini: "gemini-2.0-flash",
  ollama: "qwen2.5-coder:7b",
  openrouter: "anthropic/claude-sonnet-4",
  moonshot: "moonshot-v1-32k",
  custom: "gpt-4o",
};

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
  return {
    configuration: "配置",
    connectivity: "网络连通",
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
  };
  return labels[name] ?? name;
}

function riskLabel(level: PermissionRequest["riskLevel"]): string {
  if (level === "safe") return "低风险";
  if (level === "moderate") return "中等风险";
  return "高风险";
}

function permissionReason(request: PermissionRequest): string {
  if (["web_fetch", "web_search", "spawn_research"].includes(request.toolName)) {
    return "此操作将访问网络或外部服务，因此需要你的确认。";
  }
  if (["file_write", "file_edit"].includes(request.toolName)) {
    return "此操作将修改项目文件。你可以仅允许一次，或允许本次会话中的同类修改。";
  }
  if (request.riskLevel === "dangerous") {
    return "系统检测到高风险或不可逆操作，不会自动放行。";
  }
  return "此操作可能改变项目状态或执行较大的命令，需要你的确认。";
}

function localizeError(message: string): string {
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
