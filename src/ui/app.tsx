import React, { useState, useCallback, useEffect, useRef } from "react";
import { Box, Text, Static, useInput, useApp, useStdout } from "ink";
import type { DevAISettings } from "../types/config.js";
import type { AppState } from "../types/ui.js";
import type { PermissionRequest, PermissionDecision } from "../types/permissions.js";
import type { UIMessage } from "../types/agent.js";
import { useAgentLoop } from "./hooks/useAgentLoop.js";
import { MessageList } from "./components/MessageList.js";
import { InputBar } from "./components/InputBar.js";
import { PermissionPrompt } from "./components/PermissionPrompt.js";
import { StatusBar } from "./components/StatusBar.js";
import { Logo } from "./components/Logo.js";
import { ThemeContext, getPalette } from "./theme.js";
import { setMouseScrollCallback } from "./renderer.js";
import { logger } from "../utils/logger.js";

interface AppProps {
  settings: DevAISettings;
  cwd:      string;
  initialPrompt?: string;
  sessionId?:     string;
}

/**
 * Constrain the streaming message for the dynamic zone.
 *
 * Root cause of flicker: Ink re-renders by moving cursor up N lines and
 * rewriting. N = number of logical React lines. But the TERMINAL wraps
 * long lines automatically: a 160-char line in an 80-col terminal takes
 * 2 visual rows but Ink counts it as 1. This discrepancy causes Ink's
 * cursor to land in the wrong position → old content not fully erased →
 * "two overlapping layers". This worsens as responses grow longer.
 *
 * Three passes:
 *  1. Strip completed tool_use blocks (status !== running/pending).
 *  2. Truncate the last text block counting VISUAL lines (not logical),
 *     accounting for terminal-width wrapping.
 *  3. Hard-truncate each line to termCols so no line ever wraps.
 */
function tailMessage(msg: UIMessage, maxVisualLines: number, termCols: number): UIMessage {
  // Pass 1: completed tool_use → compact 1-line text (keeps height stable, avoids Ink cursor drift).
  // Dropping completed blocks entirely causes a multi-line → 0-line height jump which makes Ink
  // miscalculate how many lines to erase, leaving ghost content (visible flicker/overlap).
  const content: UIMessage["content"] = msg.content.map((b) => {
    if (b.type === "tool_use") {
      if (b.status === "running" || b.status === "pending") return b;
      // Completed: replace with a single-line text so zone height shrinks by N-1 instead of N
      const sym = b.status === "success" ? "✓" : b.status === "denied" ? "⊘" : "✗";
      return { type: "text" as const, text: `${sym} ${b.toolName}` };
    }
    return b;
  });

  // Pass 2+3: work on the last text block
  let lastTextIdx = -1;
  for (let i = content.length - 1; i >= 0; i--) {
    if (content[i]!.type === "text") { lastTextIdx = i; break; }
  }
  if (lastTextIdx !== -1) {
    const block = content[lastTextIdx] as { type: "text"; text: string };
    const logicalLines = block.text.split("\n");

    // Expand each logical line into visual lines (terminal wrapping simulation)
    const visualLines: string[] = [];
    for (const line of logicalLines) {
      if (line.length === 0) {
        visualLines.push("");
      } else {
        // A line of length L takes ceil(L / termCols) visual rows
        const cols = Math.max(1, termCols - 4); // -4 for paddingX={2} on each side
        for (let i = 0; i < line.length; i += cols) {
          visualLines.push(line.slice(i, i + cols));
        }
      }
    }

    if (visualLines.length > maxVisualLines) {
      // Keep last maxVisualLines visual rows
      const kept = visualLines.slice(-maxVisualLines).join("\n");
      content[lastTextIdx] = { type: "text" as const, text: kept };
    } else {
      // Pass 3: hard-truncate each line to cols even if we didn't need to trim
      const cols = Math.max(1, termCols - 4);
      const truncated = logicalLines
        .map((l) => l.length > cols ? l.slice(0, cols) : l)
        .join("\n");
      content[lastTextIdx] = { type: "text" as const, text: truncated };
    }
  }

  return { ...msg, content };
}

export function App({ settings, cwd, initialPrompt, sessionId }: AppProps): React.ReactElement {
  const { exit }   = useApp();
  const { stdout } = useStdout();

  const [appState, setAppState] = useState<AppState>("idle");
  const [pending,  setPending]  = useState<PermissionRequest | null>(null);

  const palette   = getPalette(settings.ui.theme);
  const termCols  = stdout?.columns ?? 80;
  const termRows  = stdout?.rows    ?? 30;
  // TAIL_LINES: how many lines of streaming text are shown in the dynamic zone.
  // We fill the viewport minus the chrome (StatusBar ~3 + InputBar 1 + hints 1
  // + safety margin 3 = ~8 lines).  This gives a large, comfortable window so
  // the user can read the response as it streams in — the old value of 8 made
  // the view feel like "two lines scrolling".  In primary buffer, dynamic-zone
  // growth causes the terminal to add lines to scrollback naturally (normal
  // terminal behaviour); the jitter (flickering) root cause was the isStreaming
  // bug, which is fixed independently.
  // Dynamic zone budget (must stay < termRows to avoid Ink cursor-tracking drift):
  //   chrome: 1(tool header) + 1(divider) + 1(status) + 1(hint) + 1(input) + 1(keyhints) + 2(padding) = 8 lines
  //   safety buffer: 6 lines (spinner repaints every 120ms; ±1 line drift per cycle accumulates)
  //   TAIL_LINES = termRows - 8 - 6 = termRows - 14
  // termRows=30 → 16 lines text (readable) with 6-line flicker buffer.
  const TAIL_LINES = Math.max(8, termRows - 14);

  // I018: Render self-monitoring — track repaints/sec and log state transitions
  const renderCountRef  = useRef(0);
  const renderWindowRef = useRef(Date.now());
  renderCountRef.current++;
  {
    const now = Date.now();
    if (now - renderWindowRef.current >= 1000) {
      const rps = renderCountRef.current;
      // 80ms flush interval = ~12fps normally. >20 rps means a second source of repaints.
      if (rps > 20) {
        logger.warn("render.high_frequency", { state: appState, rps, TAIL_LINES, termRows, termCols });
      }
      renderCountRef.current = 0;
      renderWindowRef.current = now;
    }
  }

  const onPermissionRequest = useCallback((req: PermissionRequest) => setPending(req), []);
  const onStateChange = useCallback((state: AppState) => {
    setAppState(state);
    if (state !== "permission_prompt") setPending(null);
  }, []);

  const { messages, statusInfo, currentActivity, streamingTokens, submit, abort, resolvePermission } =
    useAgentLoop({ settings, cwd, initialSessionId: sessionId, onPermissionRequest, onStateChange });

  // Mouse wheel: no-op now (terminal native scroll handles history)
  useEffect(() => {
    setMouseScrollCallback(() => {});
    return () => setMouseScrollCallback(() => {});
  }, []);

  const onDecide = useCallback((d: PermissionDecision) => {
    setPending(null);
    resolvePermission(d);
  }, [resolvePermission]);

  useInput((_in, key) => {
    if (key.ctrl && _in === "c") {
      if (!["idle", "completed"].includes(appState)) abort();
      else exit();
    }
  });

  // I018: Log state transitions with zone height info for flicker diagnosis
  useEffect(() => {
    const dynamicZoneEst = TAIL_LINES + 5;
    logger.info("render.state_change", {
      state: appState, TAIL_LINES, termRows, termCols,
      dynamicZoneEst,
      overflowRisk: dynamicZoneEst >= termRows,
    });
  }, [appState]);

  useEffect(() => { if (initialPrompt) submit(initialPrompt); }, []);

  // ── Static / Dynamic split ───────────────────────────────────────────────
  // Completed messages → <Static>: rendered once, written to terminal scrollback,
  // never redrawn. Only the live streaming message stays in the dynamic zone.
  // This is how Claude Code eliminates stutter: Ink only repaints the bottom strip.
  const completedMessages = messages.filter((m) => !m.isStreaming);
  const streamingMessage  = messages.find((m)  =>  m.isStreaming) ?? null;
  const hasMessages       = messages.length > 0;
  const isInputDisabled   = !["idle", "completed"].includes(appState);

  return (
    <ThemeContext.Provider value={palette}>
      <Box flexDirection="column">

        {/* ── Completed messages → Static ──────────────────────────────
            Ink writes each item once into the alt-screen buffer and never
            redraws it.  Dynamic zone stays small and fixed-height.        */}
        <Static items={completedMessages}>
          {(msg) => (
            <MessageList
              key={msg.id}
              messages={[msg]}
              hiddenAbove={0}
              showThinking={settings.ui.showThinking}
            />
          )}
        </Static>

        {/* ── Dynamic zone — only this strip repaints every 80ms ───── */}
        <Box flexDirection="column">

          {!hasMessages && (
            <Box paddingX={4} paddingY={1}>
              <Logo />
            </Box>
          )}

          {/* Streaming message — hidden during permission_prompt to keep the
              dynamic zone height stable. A growing/shrinking zone causes Ink's
              cursor-tracking to drift by ≥1 line, producing the "two overlapping
              layers" flicker the user sees when scrolled to the bottom.
              The full message content is preserved in state and will appear in
              <Static> once isStreaming → false after the permission is resolved. */}
          {streamingMessage && appState !== "permission_prompt" && (
            <MessageList
              messages={[tailMessage(streamingMessage, TAIL_LINES, termCols)]}
              hiddenAbove={0}
              showThinking={settings.ui.showThinking}
            />
          )}

          {pending && appState === "permission_prompt" && (
            <PermissionPrompt request={pending} onDecide={onDecide} />
          )}

          <StatusBar
            info={statusInfo} state={appState}
            showCost={settings.ui.showCost} showTokens={settings.ui.showTokenCount}
            currentActivity={currentActivity} streamingTokens={streamingTokens}
            termCols={termCols}
          />

          <InputBar onSubmit={submit} disabled={isInputDisabled} maxWidth={termCols - 2} />

          <Box paddingX={3}>
            <Text color={appState === "permission_prompt" ? palette.warning : palette.secondary} dimColor={appState !== "permission_prompt"}>
              {appState === "permission_prompt"
                ? "y · allow once    s · allow session    n · deny"
                : ["waiting_model", "waiting_model_after_tool", "streaming", "tool_running"].includes(appState)
                ? "Ctrl+C interrupt"
                : appState === "compacting"
                ? "summarising context — please wait…"
                : "Enter send    Ctrl+J newline    Ctrl+W del-word    Ctrl+C exit"}
            </Text>
          </Box>

        </Box>
      </Box>
    </ThemeContext.Provider>
  );
}
