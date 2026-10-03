import { useState, useRef, useCallback } from "react";
import { randomUUID } from "node:crypto";
import type { UIMessage, AgentEvent, StatusInfo, TokenUsage } from "../../types/agent.js";
import type { AppState } from "../../types/ui.js";
import type { PermissionRequest, PermissionDecision } from "../../types/permissions.js";
import type { DevAISettings } from "../../types/config.js";
import { runAgentLoop } from "../../agent/loop.js";
import { createProvider } from "../../providers/index.js";
import { buildSystemPrompt } from "../../agent/system-prompt.js";
import { ContextManager } from "../../agent/context.js";
import { ToolRegistry } from "../../tools/registry.js";
import { ToolCache } from "../../tools/cache.js";
import { MCPRegistry } from "../../mcp/registry.js";
import { PermissionManager } from "../../permissions/manager.js";
import { loadClaudeMd } from "../../memory/claude-md.js";
import { extractAndSaveMemory, loadLongTermMemory } from "../../memory/long-term.js";
import { SandboxManager } from "../../sandbox/manager.js";
import { createSession, saveSession, loadSession, deriveTitle, assertSessionWorkspace } from "../../memory/session.js";
import { addUsage, consumedTokens, withModelAccounting } from "../../providers/model-gateway.js";
import { SessionStats } from "../../utils/stats.js";
import { logger } from "../../utils/logger.js";
import { handleSlashCommand } from "../../commands/slash.js";
import { parseTokenBudget, stripTokenBudgetPhrase } from "../../utils/token-budget-parser.js";
import { runResearchLoop } from "../../agent/research-loop.js";
import type { ResearchRunner } from "../../tools/registry.js";

interface UseAgentLoopOptions {
  settings: DevAISettings;
  cwd: string;
  initialSessionId?: string;
  onPermissionRequest: (req: PermissionRequest) => void;
  onStateChange: (state: AppState) => void;
}

interface UseAgentLoopReturn {
  messages: UIMessage[];
  statusInfo: StatusInfo;
  /** One-line description of what the agent is currently doing (tool name + key arg) */
  currentActivity: string;
  /** Cumulative output tokens received during current streaming session */
  streamingTokens: number;
  submit: (userInput: string) => void;
  abort: () => void;
  resolvePermission: (decision: PermissionDecision) => void;
}

export function useAgentLoop({
  settings,
  cwd,
  initialSessionId,
  onPermissionRequest,
  onStateChange,
}: UseAgentLoopOptions): UseAgentLoopReturn {
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [statusInfo, setStatusInfo] = useState<StatusInfo>({
    model: settings.model,
    totalTokens: 0,
    estimatedCost: null,
    costCurrency: null,
  });
  const [currentActivity, setCurrentActivity] = useState<string>("");
  const [streamingTokens, setStreamingTokens] = useState<number>(0);

  const permissionResolverRef = useRef<((d: PermissionDecision) => void) | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeAssistantIdRef = useRef<string | null>(null);
  // Batch streaming text deltas — flush to state at most every 60ms to
  // avoid Ink re-rendering on every single character (causes visible flicker).
  const deltaBufferRef      = useRef<string>("");
  const tokenCountBufferRef = useRef<number>(0);
  const flushTimerRef       = useRef<ReturnType<typeof setInterval> | null>(null);
  const contextManagerRef = useRef<ContextManager | null>(null);
  const sessionRef = useRef(
    initialSessionId ? null : createSession(cwd, settings.model)
  );
  const totalUsageRef = useRef<TokenUsage>({
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    estimatedCost: null, costCurrency: null,
  });
  // Innovation 4: per-submit stats tracker
  const statsRef = useRef<SessionStats>(new SessionStats(settings.model, settings.provider));
  // Innovation 8: MCP registry persisted across submits to avoid spawning new
  // child processes on every message (connection leak fix).
  const mcpRegistryRef = useRef<MCPRegistry | null>(null);
  const mcpConnectedRef = useRef(false);
  const toolCacheRef = useRef<ToolCache>(new ToolCache());

  // ── Helpers ──────────────────────────────────────────────────────────────

  const appendMessage = useCallback((msg: UIMessage): void => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  const updateLastAssistantMessage = useCallback((delta: string): void => {
    setMessages((prev) => {
      const targetId = activeAssistantIdRef.current;
      if (!targetId) return prev;
      const index = prev.findIndex((msg) => msg.id === targetId);
      const target = prev[index];
      if (index < 0 || !target || target.role !== "assistant") return prev;
      const copy = [...prev];
      const lastBlock = target.content[target.content.length - 1];
      if (lastBlock?.type === "text") {
        const newContent = [...target.content];
        newContent[newContent.length - 1] = { type: "text", text: lastBlock.text + delta };
        copy[index] = { ...target, content: newContent, isStreaming: true };
      } else {
        copy[index] = {
          ...target,
          content: [...target.content, { type: "text", text: delta }],
          isStreaming: true,
        };
      }
      return copy;
    });
  }, []);

  const finalizeLastMessage = useCallback((): void => {
    setMessages((prev) => {
      const targetId = activeAssistantIdRef.current;
      if (!targetId) return prev;
      return prev.map((msg) =>
        msg.id === targetId ? { ...msg, isStreaming: false } : msg
      );
    });
  }, []);

  const updateToolStatus = useCallback(
    (toolId: string, status: "success" | "error" | "denied"): void => {
      setMessages((prev) =>
        prev.map((msg) => ({
          ...msg,
          content: msg.content.map((block) => {
            if (block.type === "tool_use" && block.toolId === toolId) {
              return { ...block, status };
            }
            return block;
          }),
        }))
      );
    },
    []
  );

  // ── Permission bridge ─────────────────────────────────────────────────────

  const promptUser = useCallback(
    (req: PermissionRequest): Promise<PermissionDecision> => {
      return new Promise((resolve) => {
        permissionResolverRef.current = resolve;
        onPermissionRequest(req);
        onStateChange("permission_prompt");
      });
    },
    [onPermissionRequest, onStateChange]
  );

  const resolvePermission = useCallback((decision: PermissionDecision): void => {
    if (permissionResolverRef.current) {
      permissionResolverRef.current(decision);
      permissionResolverRef.current = null;
    }
  }, []);

  // ── Main submit handler ───────────────────────────────────────────────────

  const submit = useCallback(
    async (userInput: string): Promise<void> => {
      if (abortControllerRef.current) return;

      // ── I009: Slash command interception ────────────────────────────────
      // Handle /commands instantly without consuming an LLM API call.
      // Load memory entries for /memory command (non-fatal)
      let memoryEntries: string[] | undefined;
      try {
        const mem = sessionRef.current ? await loadLongTermMemory(cwd, sessionRef.current.id) : null;
        if (mem) {
          memoryEntries = [
            mem.user            ? `User profile: ${mem.user.slice(0, 120)}` : null,
            mem.projectContext  ? `Project: ${mem.projectContext.slice(0, 120)}` : null,
            mem.projectDecisions? `Decisions: ${mem.projectDecisions.slice(0, 120)}` : null,
            mem.projectLearnings? `Learnings: ${mem.projectLearnings.slice(0, 120)}` : null,
          ].filter((x): x is string => x !== null);
        }
      } catch { /* non-fatal */ }

      const slashCtx: Parameters<typeof handleSlashCommand>[1] = {
        messageCount: messages.length,
        usage: totalUsageRef.current,
        model: settings.model,
        provider: settings.provider,
        cwd,
        sessionId: sessionRef.current?.id,
        memoryEntries,
        clearHistory: () => {
          setMessages([]);
          contextManagerRef.current = null;
          sessionRef.current = createSession(cwd, settings.model);
          totalUsageRef.current = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCost: null, costCurrency: null };
          statsRef.current = new SessionStats(settings.model, settings.provider);
        },
        triggerCompact: async () => {
          if (contextManagerRef.current) {
            onStateChange("compacting");
            const _provider = createProvider(settings);
            await contextManagerRef.current.compactWithSummary(_provider, settings.model);
            onStateChange("idle");
          }
        },
      };

      const slashResult = handleSlashCommand(userInput, slashCtx);

      if (slashResult.type === "clear") {
        appendMessage({ id: randomUUID(), role: "system", content: [{ type: "text", text: "✓ Conversation cleared." }], timestamp: new Date() });
        return;
      }
      if (slashResult.type === "compact") {
        await (slashCtx.triggerCompact as () => Promise<void>)();
        appendMessage({ id: randomUUID(), role: "system", content: [{ type: "text", text: "✓ Context compacted." }], timestamp: new Date() });
        return;
      }
      if (slashResult.type === "message") {
        appendMessage({ id: randomUUID(), role: "system", content: [{ type: "text", text: slashResult.text }], timestamp: new Date() });
        return;
      }
      // I021: /plan rewrites the user input with planning instructions before sending to LLM
      // The UI still shows the original user input; the LLM receives the enriched planning prompt.
      // type === "passthrough" → fall through unchanged
      // Wrap ALL setup + loop code so any pre-loop throw also resets state via finally.
      let errorEmitted = false;
      try {
      abortControllerRef.current = new AbortController();
      onStateChange("waiting_model");
      let effectiveInput = slashResult.type === "rewrite" ? slashResult.input : userInput;
      let dynamicHardLimit: number | undefined;
      const parsedBudget = parseTokenBudget(userInput);
      if (parsedBudget !== null) {
        dynamicHardLimit = parsedBudget;
        effectiveInput = stripTokenBudgetPhrase(userInput);
        appendMessage({
          id: randomUUID(),
          role: "system",
          content: [{ type: "text", text: `Token budget set: ${parsedBudget.toLocaleString()} tokens for this request.` }],
          timestamp: new Date(),
        });
      }

      // Reset stats for this submit
      statsRef.current = new SessionStats(settings.model, settings.provider);

      // Initialize context manager on first use
      if (!contextManagerRef.current) {
        contextManagerRef.current = new ContextManager(settings, settings.model);

        if (initialSessionId && !sessionRef.current) {
          const loaded = await loadSession(initialSessionId);
          if (loaded) {
            sessionRef.current = loaded;
            for (const msg of loaded.messages) {
              contextManagerRef.current.append(msg);
            }
          } else {
            sessionRef.current = createSession(cwd, settings.model);
          }
        }
      }

      const session = sessionRef.current ?? createSession(cwd, settings.model);
      assertSessionWorkspace(session, cwd);
      if (!sessionRef.current) sessionRef.current = session;
      if (!session.title) session.title = deriveTitle(effectiveInput);

      appendMessage({
        id: randomUUID(),
        role: "user",
        content: [{ type: "text", text: effectiveInput }],
        timestamp: new Date(),
      });
      const assistantMessageId = randomUUID();
      activeAssistantIdRef.current = assistantMessageId;
      appendMessage({
        id: assistantMessageId,
        role: "assistant",
        content: [],
        timestamp: new Date(),
        isStreaming: true,
      });

      contextManagerRef.current.append({ role: "user", content: effectiveInput });
      session.messages.push({ role: "user", content: effectiveInput });

      const provider = createProvider(settings);

      // Innovation 8 (MCP lifecycle fix): connect once, reuse across all submits.
      if (!mcpConnectedRef.current) {
        mcpConnectedRef.current = true;
        const reg = new MCPRegistry();
        if (settings.mcpServers.length > 0) {
          await reg.connect(settings.mcpServers);
        }
        mcpRegistryRef.current = reg;
      }
      const mcpRegistry = mcpRegistryRef.current!;

      // Innovation 5: Docker sandbox (also initialised once — SandboxManager is stateless)
      let activeSandbox: SandboxManager | undefined;
      if (settings.sandbox.enabled) {
        const mgr = new SandboxManager(settings.sandbox);
        if (await mgr.isAvailable()) {
          activeSandbox = mgr;
        } else {
          // Surface warning via a system message so it's visible in the UI
          appendMessage({
            id: randomUUID(),
            role: "system",
            content: [{
              type: "text",
              text: "⚠ **沙箱未激活**：Docker 不可用，bash 命令将在宿主机执行并需要手动确认。\n安装 Docker Desktop 后重启以启用沙箱隔离。",
            }],
            timestamp: new Date(),
            isStreaming: false,
          });
        }
      }

      const searchConfig = {
        tavilyApiKey:  settings.search?.tavilyApiKey,
        braveApiKey:   settings.search?.braveApiKey,
        serperApiKey:  settings.search?.serperApiKey,
        defaultProvider: settings.search?.defaultProvider,
      };
      // I024: research sub-loop runner injected to avoid circular import
      const researchRunner: ResearchRunner = (query, depth, onProgress) =>
        runResearchLoop({
          query,
          depth: depth ?? "basic",
          provider,
          model: settings.model,
          maxTokens: Math.min(settings.maxTokens, 8192),
          searchConfig,
          cwd,
          onProgress,
          signal: abortControllerRef.current?.signal,
        });
      // I027: hooks config from settings
      const hooksConfig = settings.hooks ?? {};
      const tools = new ToolRegistry(
        cwd,
        mcpRegistry,
        activeSandbox,
        searchConfig,
        researchRunner,
        undefined,
        hooksConfig,
        settings.github?.token,
        toolCacheRef.current,
      );
      const permissions = new PermissionManager(settings, promptUser, !!activeSandbox);

      // Innovation 3: inject summary context from prior compressions
      const claudeMd = await loadClaudeMd(cwd, settings.context.claudeMdPaths);
      const summaryContext = contextManagerRef.current.getSummaryContext();
      const systemPrompt = await buildSystemPrompt(cwd, claudeMd, settings, summaryContext, effectiveInput, sessionRef.current?.id);

      setCurrentActivity("");
      setStreamingTokens(0);

      // Start flush timer: drain delta buffer into React state at most every 80ms (~12fps).
      // 80ms matches StatusBar's non-streaming spinner interval and reduces render frequency
      // vs the previous 60ms without making text feel laggy.
      deltaBufferRef.current = "";
      tokenCountBufferRef.current = 0;
      flushTimerRef.current = setInterval(() => {
        const chunk      = deltaBufferRef.current;
        const tokenCount = tokenCountBufferRef.current;
        if (chunk.length === 0 && tokenCount === 0) return;
        deltaBufferRef.current      = "";
        tokenCountBufferRef.current = 0;
        if (chunk.length > 0) updateLastAssistantMessage(chunk);
        if (tokenCount  > 0) setStreamingTokens((n) => n + tokenCount);
      }, 80);

      const onEvent = (event: AgentEvent): void => {
        switch (event.type) {
          case "status":
            if (event.phase === "waiting_model") onStateChange("waiting_model");
            else if (event.phase === "waiting_model_after_tool") onStateChange("waiting_model_after_tool");
            else if (event.phase === "streaming") onStateChange("streaming");
            else if (event.phase === "tool_running") onStateChange("tool_running");
            else if (event.phase === "completed") onStateChange("completed");
            break;

          case "text_delta":
            // Accumulate into buffers — flushed by interval above (no per-token setState)
            deltaBufferRef.current      += event.delta;
            tokenCountBufferRef.current += event.delta.length;
            break;

          case "thinking_delta":
            if (settings.ui.showThinking) {
              setMessages((prev) => {
                const targetId = activeAssistantIdRef.current;
                if (!targetId) return prev;
                const targetIndex = prev.findIndex((msg) => msg.id === targetId);
                const target = prev[targetIndex];
                if (targetIndex < 0 || !target) return prev;
                const copy = [...prev];
                const lastBlock = target.content[target.content.length - 1];
                if (lastBlock?.type === "thinking") {
                  const newContent = [...target.content];
                  newContent[newContent.length - 1] = { type: "thinking", text: lastBlock.text + event.delta };
                  copy[targetIndex] = { ...target, content: newContent };
                } else {
                  copy[targetIndex] = {
                    ...target,
                    content: [...target.content, { type: "thinking", text: event.delta }],
                  };
                }
                return copy;
              });
            }
            break;

          case "tool_pending": {
            const inp = event.input as Record<string, unknown>;
            const arg =
              typeof inp["command"] === "string" ? inp["command"].slice(0, 60) :
              typeof inp["path"]    === "string" ? inp["path"] :
              typeof inp["pattern"] === "string" ? inp["pattern"].slice(0, 60) :
              typeof inp["url"]     === "string" ? inp["url"].slice(0, 60) : "";
            setCurrentActivity(arg ? `${event.toolName}  ${arg}` : event.toolName);
            setMessages((prev) => {
              const targetId = activeAssistantIdRef.current;
              if (!targetId) return prev;
              const targetIndex = prev.findIndex((msg) => msg.id === targetId);
              const target = prev[targetIndex];
              if (targetIndex < 0 || !target) return prev;
              const copy = [...prev];
              copy[targetIndex] = {
                ...target,
                content: [
                  ...target.content,
                  {
                    type: "tool_use" as const,
                    toolName: event.toolName,
                    toolId: event.toolId,
                    input: event.input,
                    status: "pending" as const,
                  },
                ],
              };
              return copy;
            });
            break;
          }

          case "tool_start":
            setMessages((prev) => prev.map((msg) => ({
              ...msg,
              content: msg.content.map((block) =>
                block.type === "tool_use" && block.toolId === event.toolId
                  ? { ...block, status: "running" as const }
                  : block
              ),
            })));
            break;

          case "tool_result": {
            setCurrentActivity("");
            const resultStatus = event.isError ? "error" : "success";
            // For file_edit (and file_write): attach the result content to the
            // tool_use block so ToolCall can render it as a diff.
            const SHOW_RESULT_TOOLS = new Set(["file_edit", "file_write"]);
            if (!event.isError && SHOW_RESULT_TOOLS.has(event.toolName)) {
              setMessages((prev) =>
                prev.map((msg) => ({
                  ...msg,
                  content: msg.content.map((block) => {
                    if (block.type === "tool_use" && block.toolId === event.toolId) {
                      return { ...block, status: resultStatus, result: event.content };
                    }
                    return block;
                  }),
                }))
              );
            } else {
              updateToolStatus(event.toolId, resultStatus);
            }
            break;
          }

          case "tool_denied":
            updateToolStatus(event.toolId, "denied");
            break;

          case "usage": {
            const newUsage = addUsage(totalUsageRef.current, { inputTokens: event.inputTokens, outputTokens: event.outputTokens, cacheReadTokens: event.cacheReadTokens, cacheWriteTokens: event.cacheWriteTokens, estimatedCost: event.estimatedCost ?? null, costCurrency: event.costCurrency ?? null });
            totalUsageRef.current = newUsage;
            // Fix: update context manager's token count so shouldCompact() can trigger.
            // Without this, lastInputTokens stays 0 and compaction never fires automatically.
            contextManagerRef.current?.updateTokenCount({
              input_tokens: newUsage.inputTokens,
              output_tokens: newUsage.outputTokens,
              cache_creation_input_tokens: newUsage.cacheWriteTokens,
              cache_read_input_tokens: newUsage.cacheReadTokens,
            } as Parameters<ContextManager["updateTokenCount"]>[0]);
            // Innovation 8: compute budget pressure for UI coloring
            const hardLimit = settings.tokenBudget?.hardLimit;
            const budgetUsedPct = hardLimit
              ? Math.min(100, Math.round(((newUsage.inputTokens + newUsage.outputTokens + newUsage.cacheReadTokens + newUsage.cacheWriteTokens + (newUsage.unknownReservedTokens ?? 0)) / hardLimit) * 100))
              : undefined;
            setStatusInfo({
              model: settings.model,
              totalTokens: newUsage.inputTokens + newUsage.outputTokens,
              estimatedCost: newUsage.estimatedCost,
              costCurrency: newUsage.costCurrency,
              sessionId: session.id,
              budgetUsedPct,
            });
            break;
          }

          case "done":
            // Finalization (isStreaming→false) is handled atomically in the finally
            // block AFTER the delta buffer is drained, to prevent the batch-ordering
            // race where updateLastAssistantMessage (isStreaming:true) overwrites
            // finalizeLastMessage (isStreaming:false) within the same React batch.
            setCurrentActivity("");
            onStateChange("completed");
            break;

          case "checkpoint":
            // I026: agent requested human review — show system message and pause
            finalizeLastMessage();
            appendMessage({
              id: randomUUID(),
              role: "system",
              content: [{ type: "text", text: `⏸ **Checkpoint**: ${event.message}\n\nReview the above and reply to continue.` }],
              timestamp: new Date(),
            });
            onStateChange("idle");
            break;

          case "tool_progress":
            // Append as Static (isStreaming:false) → renders once, never repainted → zero flicker
            appendMessage({
              id: randomUUID(),
              role: "tool_result" as const,
              content: [{ type: "text" as const, text: event.chunk }],
              timestamp: new Date(),
              isStreaming: false,
            });
            break;

          case "error":
            errorEmitted = true;
            finalizeLastMessage();
            setMessages((prev) => [
              ...prev,
              {
                id: randomUUID(),
                role: "system" as const,
                content: [{ type: "error" as const, message: event.error.message }],
                timestamp: new Date(),
              },
            ]);
            onStateChange("error");
            break;
        }
      };

      // Innovation 1: parallel tool execution via runAgentLoop
        // Innovation 2: tool cache via ToolRegistry
        // Innovation 4: stats tracking via statsRef
        const loopResult = await runAgentLoop(
          provider,
          {
            model: settings.model,
            maxTokens: settings.maxTokens,
            systemPrompt,
            conversationHistory: contextManagerRef.current.getHistory(),
            compactionState: session.compactionState,
            onCompactionChange: async (state) => { session.compactionState = state; },
            onHistoryChange: async (history) => { session.messages = history; await saveSession(session); },
            maxIterations: settings.executionBudget.maxModelTurnsPerRun,
            historyBudget: { maxContextTokens: settings.context.maxContextTokens, keepRecentMessages: settings.context.keepRecentMessages },
            onEvent,
            signal: abortControllerRef.current.signal,
            // Innovation 8 + I010: pass budget (dynamic override wins over config)
            tokenBudget: (dynamicHardLimit ?? settings.tokenBudget?.hardLimit) !== undefined ? {
              warningThreshold: settings.tokenBudget?.warningThreshold,
              hardLimit: dynamicHardLimit ?? settings.tokenBudget!.hardLimit,
              priorTokens: consumedTokens(totalUsageRef.current),
            } : undefined,
          },
          tools,
          permissions,
          statsRef.current
        );

        // Sync final usage into stats
        statsRef.current.setFinalUsage(loopResult.totalUsage);

        // Append new messages to context and session
        const prevCount = contextManagerRef.current.messageCount;
        for (const msg of loopResult.updatedHistory.slice(prevCount)) {
          contextManagerRef.current.append(msg);

        }

        // Innovation 7: extract and persist long-term memory using current provider.
        // Works with any provider (DeepSeek, Anthropic, etc.) — no longer requires Anthropic key.
        if (settings.memory.enabled) {
          await withModelAccounting({ model: settings.model, maxTokens: settings.maxTokens, systemPrompt: "", conversationHistory: [], onEvent, tokenBudget: { warningThreshold: settings.tokenBudget.warningThreshold, hardLimit: dynamicHardLimit ?? settings.tokenBudget.hardLimit, priorTokens: consumedTokens(totalUsageRef.current) } }, async () => {
            await extractAndSaveMemory(
            cwd,
            session.messages,
            provider,
            settings.model,
            true,
            session.id,
          ).catch((err) => logger.warn("memory.extract.background_error", err));
          });
        }

        session.totalUsage = totalUsageRef.current;
        await saveSession(session);
      } catch (err) {
        logger.error("useAgentLoop.submit.error", err);
        if (!errorEmitted) {
          errorEmitted = true;
          const error = err instanceof Error ? err : new Error(String(err));
          appendMessage({
            id: randomUUID(),
            role: "system",
            content: [{ type: "error", message: error.message }],
            timestamp: new Date(),
          });
          onStateChange("error");
        }
      } finally {
        // Stop flush timer
        if (flushTimerRef.current) {
          clearInterval(flushTimerRef.current);
          flushTimerRef.current = null;
        }
        // ── Atomic drain + finalize ─────────────────────────────────────────
        // CRITICAL: must be ONE setMessages call.
        // If we called updateLastAssistantMessage (sets isStreaming:true) and
        // finalizeLastMessage (sets isStreaming:false) as two separate setState
        // calls, React batches them and the later one wins.  When the 'done'
        // event's finalizeLastMessage fires first (isStreaming→false) and the
        // buffer drain fires second (isStreaming→true), the message ends up
        // permanently stuck in the streaming zone, shown truncated forever.
        const remainingChunk  = deltaBufferRef.current;
        deltaBufferRef.current = "";
        setMessages((prev) => {
          const targetId = activeAssistantIdRef.current;
          if (!targetId) return prev;
          const targetIndex = prev.findIndex((msg) => msg.id === targetId);
          const target = prev[targetIndex];
          if (targetIndex < 0 || !target) return prev;
          const copy = [...prev];
          // Only update content for assistant messages; always clear isStreaming.
          let content = target.content;
          if (remainingChunk.length > 0 && target.role === "assistant") {
            const lastBlock = content[content.length - 1];
            if (lastBlock?.type === "text") {
              content = [...content];
              (content as typeof target.content)[content.length - 1] =
                { type: "text", text: lastBlock.text + remainingChunk };
            } else {
              content = [...content, { type: "text", text: remainingChunk }];
            }
          }
          if (content === target.content && target.isStreaming === false) return prev;
          copy[targetIndex] = { ...target, content, isStreaming: false };
          return copy;
        });
        // Drain token count buffer
        if (tokenCountBufferRef.current > 0) {
          setStreamingTokens((n) => n + tokenCountBufferRef.current);
          tokenCountBufferRef.current = 0;
        }
        abortControllerRef.current = null;
        activeAssistantIdRef.current = null;
        if (!errorEmitted) onStateChange("completed");
      }
    },
    [settings, cwd, initialSessionId, appendMessage, updateLastAssistantMessage,
     finalizeLastMessage, updateToolStatus, promptUser, onStateChange]
  );

  const abort = useCallback((): void => {
    if (permissionResolverRef.current) {
      permissionResolverRef.current("deny");
      permissionResolverRef.current = null;
    }
    abortControllerRef.current?.abort();
    finalizeLastMessage();
    onStateChange("idle");
  }, [finalizeLastMessage, onStateChange]);

  return { messages, statusInfo, currentActivity, streamingTokens, submit, abort, resolvePermission };
}
