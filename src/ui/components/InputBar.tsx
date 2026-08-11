import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { useTheme, symbols } from "../theme.js";
import { consumeShiftEnter } from "../renderer.js";

interface InputBarProps {
  onSubmit:     (text: string) => void;
  disabled?:    boolean;
  placeholder?: string;
  maxWidth?:    number;
}

/** Jump to the start of the word to the left of pos. */
function prevWordBoundary(text: string, pos: number): number {
  let i = pos - 1;
  while (i > 0 && text[i] === " ") i--;      // skip trailing spaces
  while (i > 0 && text[i - 1] !== " ") i--;  // skip word chars
  return Math.max(0, i);
}

/** Jump to the start of the next word to the right of pos. */
function nextWordBoundary(text: string, pos: number): number {
  let i = pos;
  while (i < text.length && text[i] !== " ") i++;  // skip current word
  while (i < text.length && text[i] === " ") i++;  // skip spaces
  return i;
}

export function InputBar({
  onSubmit,
  disabled    = false,
  placeholder = "Type a message…",
  maxWidth,
}: InputBarProps): React.ReactElement {
  const palette = useTheme();
  const [value,      setValue]      = useState("");
  const [cursorPos,  setCursorPos]  = useState(0);
  const [history,    setHistory]    = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);

  useInput((input, key) => {
    if (disabled) return;

    // Ctrl+J — traditional "newline without submit" shortcut
    if (key.ctrl && input === "j") {
      setValue((p) => p.slice(0, cursorPos) + "\n" + p.slice(cursorPos));
      setCursorPos((p) => p + 1);
      return;
    }

    // Enter — check Shift+Enter flag first (renderer sets it before emitting \r)
    if (key.return) {
      if (consumeShiftEnter()) {
        // Shift+Enter: insert newline instead of submitting
        setValue((p) => p.slice(0, cursorPos) + "\n" + p.slice(cursorPos));
        setCursorPos((p) => p + 1);
        return;
      }
      const t = value.trim();
      if (!t) return;
      setHistory((p) => [t, ...p].slice(0, 100));
      setHistoryIdx(-1);
      setValue("");
      setCursorPos(0);
      onSubmit(t);
      return;
    }

    // History navigation (only when value is empty)
    if (key.upArrow && value.length === 0) {
      const i = Math.min(historyIdx + 1, history.length - 1);
      setHistoryIdx(i);
      const v = history[i] ?? "";
      setValue(v);
      setCursorPos(v.length);
      return;
    }
    if (key.downArrow && historyIdx >= 0) {
      const i = Math.max(historyIdx - 1, -1);
      setHistoryIdx(i);
      const v = i === -1 ? "" : (history[i] ?? "");
      setValue(v);
      setCursorPos(v.length);
      return;
    }

    // Cursor movement
    if (key.leftArrow) {
      if ((key as { ctrl?: boolean }).ctrl) {
        // Ctrl+Left — jump to start of previous word
        setCursorPos((p) => prevWordBoundary(value, p));
      } else {
        setCursorPos((p) => Math.max(0, p - 1));
      }
      return;
    }
    if (key.rightArrow) {
      if ((key as { ctrl?: boolean }).ctrl) {
        // Ctrl+Right — jump to start of next word
        setCursorPos((p) => nextWordBoundary(value, p));
      } else {
        setCursorPos((p) => Math.min(value.length, p + 1));
      }
      return;
    }

    // Home / Ctrl+A
    if ((key.ctrl && input === "a") || (key as { home?: boolean }).home) {
      setCursorPos(0); return;
    }
    // End / Ctrl+E
    if ((key.ctrl && input === "e") || (key as { end?: boolean }).end) {
      setCursorPos(value.length); return;
    }

    // Delete char before cursor
    if (key.backspace || key.delete) {
      if (cursorPos === 0) return;
      if ((key as { ctrl?: boolean }).ctrl) {
        // Ctrl+Backspace — delete entire word before cursor
        const wb = prevWordBoundary(value, cursorPos);
        setValue((p) => p.slice(0, wb) + p.slice(cursorPos));
        setCursorPos(wb);
      } else {
        setValue((p) => p.slice(0, cursorPos - 1) + p.slice(cursorPos));
        setCursorPos((p) => p - 1);
      }
      return;
    }

    // Ctrl+U — clear all
    if (key.ctrl && input === "u") {
      setValue("");
      setCursorPos(0);
      return;
    }

    // Ctrl+W — delete word before cursor (bash-style alias for Ctrl+Backspace)
    if (key.ctrl && input === "w") {
      if (cursorPos === 0) return;
      const wb = prevWordBoundary(value, cursorPos);
      setValue((p) => p.slice(0, wb) + p.slice(cursorPos));
      setCursorPos(wb);
      return;
    }

    // Regular character insertion (no char limit)
    if (input && !key.ctrl && !key.meta) {
      setValue((p) => p.slice(0, cursorPos) + input + p.slice(cursorPos));
      setCursorPos((p) => p + input.length);
    }
  });

  const isEmpty = value.length === 0;

  // v0.7.0: Borderless design — CC-style clean prompt row.
  // Left accent bar (▎) replaces the box border:
  //   gold  = active with content (accent)
  //   gray  = idle / empty / disabled
  const barColor = !disabled && !isEmpty ? palette.accent : palette.secondary;

  return (
    <Box flexDirection="column" paddingX={1} marginX={1} marginBottom={0} width={maxWidth}>
      {/* Subtle top rule — spans full input width */}
      <Text color={palette.secondary} dimColor>{"━".repeat(Math.max(20, (maxWidth ?? 80) - 4))}</Text>

      <Box flexDirection="row">
        {/* Left accent bar — visual grounding without a full box border */}
        <Text color={barColor} dimColor={disabled || isEmpty}>{"▎"}</Text>
        <Box flexDirection="column" flexGrow={1} paddingLeft={1}>
          {disabled ? (
            <Box>
              <Text color={palette.secondary}>{symbols.promptAlt}{" "}</Text>
              <Text color={palette.secondary} dimColor>{symbols.ellipsis}</Text>
            </Box>
          ) : isEmpty ? (
            <Box>
              <Text color={palette.secondary}>{symbols.promptAlt}{" "}</Text>
              <Text color={palette.secondary} dimColor>{placeholder}</Text>
            </Box>
          ) : (
            <MultilineInput value={value} cursorPos={cursorPos} palette={palette} />
          )}
        </Box>
      </Box>
    </Box>
  );
}

/**
 * Renders a multiline value with an inline cursor block.
 * Splits on \n so each line is its own <Text> row.
 */
function MultilineInput({
  value,
  cursorPos,
  palette,
}: {
  value: string;
  cursorPos: number;
  palette: ReturnType<typeof useTheme>;
}): React.ReactElement {
  // Build per-line segments with cursor injected at cursorPos
  const lines: React.ReactElement[] = [];
  let pos = 0;

  const rawLines = value.split("\n");
  for (let li = 0; li < rawLines.length; li++) {
    const line = rawLines[li] ?? "";
    const lineStart = pos;
    const lineEnd   = pos + line.length;

    // Prefix on first line only (use promptAlt ▸ for cleaner look)
    const prefix = li === 0
      ? <Text key="pfx" color={palette.secondary}>{symbols.promptAlt}{" "}</Text>
      : null;

    if (cursorPos >= lineStart && cursorPos <= lineEnd) {
      // Cursor is on this line
      const localCursor = cursorPos - lineStart;
      const before   = line.slice(0, localCursor);
      const atCursor = line[localCursor] ?? " ";
      const after    = line.slice(localCursor + 1);

      lines.push(
        <Box key={li} flexDirection="row">
          {prefix}
          <Text color={palette.primary}>{before}</Text>
          <Text color={palette.accent} bold>{atCursor === " " ? "▊" : atCursor}</Text>
          <Text color={palette.primary}>{after}</Text>
        </Box>
      );
    } else {
      lines.push(
        <Box key={li} flexDirection="row">
          {prefix}
          <Text color={palette.primary}>{line}</Text>
        </Box>
      );
    }

    pos = lineEnd + 1; // +1 for the \n
  }

  return <>{lines}</>;
}
