/**
 * StatusBar — session status footer.
 *
 * v0.7.0 visual redesign (CC fusion):
 *   - ━ heavy horizontal divider (CC: HEAVY_HORIZONTAL) replacing thin ─
 *   - Right-aligned model + cost metrics with clear visual weight
 *   - Context window % indicator (CC-style)
 *   - Cleaner two-column layout: left=state/activity, right=metrics
 *   - Brand-colored spinner using accent (gold) during active states
 */

import React from "react";
import { Box, Text } from "ink";
import type { StatusInfo } from "../../types/agent.js";
import type { AppState } from "../../types/ui.js";
import { formatCost, formatTokens } from "../../utils/cost-calculator.js";
import { useTheme, symbols } from "../theme.js";

interface StatusBarProps {
  info:            StatusInfo;
  state:           AppState;
  showCost:        boolean;
  showTokens:      boolean;
  currentActivity: string;
  streamingTokens: number;
  termCols?:       number;
}

// Braille spinner — kept for personality; coloured gold during active states
const SPINNER = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];

const STATE_LABEL: Record<AppState, string> = {
  idle:                     "就绪",
  waiting_model:            "等待模型首字节",
  waiting_model_after_tool: "工具已完成，等待模型继续",
  streaming:                "模型正在输出",
  tool_running:             "正在执行工具",
  completed:                "任务已结束",
  permission_prompt:        "等待确认",
  error:                    "发生错误",
  compacting:               "正在压缩上下文",
};

function fmtSecs(s: number): string {
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

export function StatusBar({
  info, state, showCost, showTokens, currentActivity, streamingTokens, termCols = 80,
}: StatusBarProps): React.ReactElement {
  const palette = useTheme();
  const [frame,   setFrame]   = React.useState(0);
  const [elapsed, setElapsed] = React.useState(0);
  const t0 = React.useRef<number | null>(null);

  React.useEffect(() => {
    // No timer during: idle, error, streaming (text IS feedback), permission_prompt
    // (user reading Y/S/N — any repaint causes cursor-tracking drift → flicker).
    // Only animate for tool_running and compacting.
    if (state === "idle" || state === "completed" || state === "error" || state === "streaming" || state === "permission_prompt") return;
    const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER.length), 200);
    return () => clearInterval(id);
  }, [state]);

  React.useEffect(() => {
    if (state === "idle" || state === "completed" || state === "error") { t0.current = null; setElapsed(0); return; }
    if (!t0.current) t0.current = Date.now();
    // permission_prompt: any repaint causes cursor-tracking drift → no timer.
    if (state === "permission_prompt") return;
    // streaming: use a 10s interval so the user can see time passing when the
    // model is slow (long TTFT / large context). Fine-grained 1s updates are
    // unnecessary — token counter already provides feedback when tokens arrive.
    const interval = state === "streaming" ? 10_000 : 1_000;
    const id = setInterval(() => {
      if (t0.current) setElapsed(Math.floor((Date.now() - t0.current) / 1000));
    }, interval);
    return () => clearInterval(id);
  }, [state]);

  // During streaming, freeze spinner at current frame (no independent 120ms timer).
  // Drive frame advancement from the elapsed ticker (1s) only when not streaming.
  const spinnerFrame = state === "streaming"
    ? (frame % SPINNER.length)   // frozen — no new setFrame calls
    : frame;

  const isActive = !["idle", "completed", "error"].includes(state);
  const isAlert  = state === "permission_prompt" || state === "error";

  // State indicator: spinner when active, bullet when idle
  const spinner  = isActive ? (SPINNER[spinnerFrame] ?? "⠋") : symbols.bullet;

  // Color scheme:
  //   permission_prompt / error → error red (demands attention)
  //   active states             → accent gold (engaged)
  //   idle                      → secondary gray (at rest)
  const stateColor = isAlert  ? palette.error
                   : isActive ? palette.accent
                   : palette.secondary;

  // Context window percentage (rough estimate from tokens)
  const pct = info.budgetUsedPct;

  // Activity hint shown below main row.
  // IMPORTANT: hint must be non-null for ALL streaming states from the very first
  // render — if it starts null and becomes non-null when streamingTokens > 0, the
  // StatusBar grows by 1 line, making the dynamic zone taller and forcing the
  // terminal to scroll (scrollbar drifts during output).
  const hint =
    state === "permission_prompt" ? "  y · allow once    s · allow session    n · deny"
    : state === "streaming"       ? (streamingTokens > 0 ? `  ${streamingTokens} tok` : elapsed > 5 ? `  ${symbols.clock} ${fmtSecs(elapsed)}` : "  …")
    : state === "waiting_model"   ? "  模型请求已发出，尚未收到内容"
    : state === "waiting_model_after_tool" ? "  工具结果已回传，Agent 循环仍在继续"
    : state === "tool_running"    ? "  …"   // keep same height as streaming to avoid 1-line jump
    : state === "compacting"      ? "  summarising context…"
    : null;

  return (
    <Box flexDirection="column" paddingX={2}>

      {/* ━━━ Heavy divider — full terminal width ━━━ */}
      <Text color={palette.secondary} dimColor>
        {"━".repeat(Math.max(20, termCols - 4))}
      </Text>

      {/* Main status row */}
      <Box>

        {/* Left: spinner + state label + elapsed + activity */}
        <Box flexGrow={1} flexDirection="row">
          {/* Spinner / bullet */}
          <Text color={stateColor}>{spinner}{" "}</Text>

          {/* State label */}
          <Text
            color={stateColor}
            bold={isAlert}
          >
            {STATE_LABEL[state]}
          </Text>

          {/* Elapsed time (only when active and > 0) */}
          {isActive && elapsed > 0 && (
            <Text color={palette.secondary}>
              {"  "}{symbols.clock}{" "}{fmtSecs(elapsed)}
            </Text>
          )}

          {/* Current tool activity */}
          {state === "tool_running" && currentActivity ? (
            <Text color={palette.secondary}>
              {"  "}{currentActivity.slice(0, 48)}
            </Text>
          ) : null}
        </Box>

        {/* Right: metrics — tokens, budget %, cost, session, model */}
        <Box flexDirection="row" gap={2}>

          {/* Token count + budget % */}
          {showTokens && info.totalTokens > 0 && (
            <Text color={
              pct !== undefined && pct >= 95 ? palette.error :
              pct !== undefined && pct >= 80 ? palette.warning :
              palette.secondary
            } dimColor>
              {formatTokens(info.totalTokens)}
              {pct !== undefined ? ` ${pct}%` : ""}
            </Text>
          )}

          {/* Estimated cost */}
          {showCost && info.estimatedCost !== null && info.estimatedCost > 0 && (
            <Text color={palette.secondary} dimColor>
              {formatCost(info.estimatedCost, info.costCurrency)}
            </Text>
          )}

          {/* Model name (trimmed) */}
          {info.model && (
            <Text color={palette.secondary} dimColor>
              {shortModel(info.model)}
            </Text>
          )}

          {/* Session ID */}
          {info.sessionId && (
            <Text color={palette.secondary} dimColor>
              {symbols.memory}{"#"}{info.sessionId.slice(0, 6)}
            </Text>
          )}
        </Box>
      </Box>

      {/* Hint row — only for permission prompt and streaming */}
      {hint && (
        <Box paddingLeft={2}>
          <Text
            color={state === "permission_prompt" ? palette.error : palette.secondary}
            bold={state === "permission_prompt"}
            dimColor={state !== "permission_prompt"}
          >
            {hint}
          </Text>
        </Box>
      )}
    </Box>
  );
}

/** Shorten model name for compact display.
 *  e.g. "claude-sonnet-4-6" → "sonnet-4-6"
 *       "gpt-4o"            → "gpt-4o"
 */
function shortModel(model: string): string {
  return model.replace(/^claude-/, "");
}
