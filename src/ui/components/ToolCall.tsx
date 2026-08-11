/**
 * ToolCall — visual representation of a single tool execution.
 *
 * v0.7.0 visual redesign (CC fusion):
 *   - Single ● indicator (CC's ToolUseLoader pattern), coloured by state:
 *       gold  = running (blinking)
 *       green = success (static)
 *       red   = error (static)
 *       gray  = denied / pending (dim)
 *   - Tool category icon retained as a dim second column (devai's unique identity)
 *   - Diff output rendered inline under file_edit / file_write success
 *   - Diff lines coloured with CC's soft rgb() palette (green/red)
 */

import React from "react";
import { Box, Text } from "ink";
import type { ToolCallStatus } from "../../types/agent.js";
import { useTheme, symbols } from "../theme.js";

interface ToolCallProps {
  toolName: string;
  input:    unknown;
  status:   ToolCallStatus;
  result?:  string;  // diff content for file_edit/file_write; error text for errors
}

// ── Tool category icons ────────────────────────────────────────────────────

const TOOL_ICON: Record<string, string> = {
  bash:       symbols.toolBash,
  file_read:  symbols.toolFileRead,
  file_write: symbols.toolFileWrite,
  file_edit:  symbols.toolFileEdit,
  glob:       symbols.toolGlob,
  grep:       symbols.toolGrep,
  web_fetch:  symbols.toolWebFetch,
};

function getToolIcon(name: string): string {
  if (name.includes("__")) return symbols.toolMcp;
  return TOOL_ICON[name] ?? symbols.toolMcp;
}

// Maximum diff lines rendered in dynamic zone; keeps zone height stable.
// Full diff is always visible in <Static> once the message is complete.
const MAX_DIFF_LINES = 20;

// ── Main component ─────────────────────────────────────────────────────────

export function ToolCall({ toolName, input, status, result }: ToolCallProps): React.ReactElement {
  const palette = useTheme();
  const isRunning = status === "running";
  const isDone    = status === "success" || status === "denied";
  const isErr     = status === "error";
  const isDenied  = status === "denied";
  const isPending = status === "pending";

  // ── Bullet color & appearance ──────────────────────────────────────────
  // No blink animation: setInterval-driven state changes trigger full Ink
  // repaints at 600ms, causing cursor-tracking drift and the "two-layer"
  // flicker. Static gold bullet already communicates "in progress" clearly;
  // the StatusBar spinner handles the global activity indicator.
  const bulletColor =
    isErr               ? palette.toolError   :
    isDone && !isDenied ? palette.toolSuccess  :
    isRunning           ? palette.toolRunning  :
    palette.secondary;

  const bulletChar = symbols.bullet;

  // ── Tool summary line ──────────────────────────────────────────────────
  const summary = summarizeInput(toolName, input);
  const icon    = getToolIcon(toolName);

  return (
    <Box flexDirection="column">
      {/* Main row: ● icon name  arg */}
      <Box>
        {/* Status bullet — 2 cols wide (matches CC's minWidth={2}) */}
        <Box minWidth={2}>
          <Text
            color={bulletColor}
            dimColor={isPending || isDenied}
          >
            {bulletChar}
          </Text>
        </Box>

        {/* Tool icon — dim category hint */}
        <Text color={palette.secondary} dimColor>
          {icon}{"  "}
        </Text>

        {/* Tool name */}
        <Text
          color={isRunning ? palette.primary : palette.secondary}
          dimColor={isDone}
          bold={isRunning}
        >
          {toolName}
        </Text>

        {/* Summary arg */}
        {summary ? (
          <Text color={palette.secondary} dimColor>
            {"  "}{summary}
          </Text>
        ) : null}
      </Box>

      {/* Error result (truncated) */}
      {isErr && result && (
        <Box marginLeft={3}>
          <Text color={palette.error} dimColor>
            {result.slice(0, 240)}
          </Text>
        </Box>
      )}

      {/* Diff output for file_edit / file_write on success */}
      {!isErr && isDone && result && (
        <DiffDisplay result={result} palette={palette} />
      )}
    </Box>
  );
}

// ── Diff display — CC-inspired colour palette ──────────────────────────────

function DiffDisplay({
  result,
  palette,
}: {
  result: string;
  palette: ReturnType<typeof useTheme>;
}): React.ReactElement {
  const allLines = result.split("\n");
  const truncated = allLines.length > MAX_DIFF_LINES;
  const lines = truncated ? allLines.slice(0, MAX_DIFF_LINES) : allLines;
  return (
    <Box marginLeft={3} flexDirection="column">
      {lines.map((line, i) => {
        const isAdded   = line.startsWith("+ ");
        const isRemoved = line.startsWith("- ");
        const isHeader  = line.startsWith("──");

        const color = isAdded   ? palette.diffAdded
                    : isRemoved ? palette.diffRemoved
                    : isHeader  ? palette.secondary
                    : palette.secondary;

        return (
          <Text
            key={i}
            color={color}
            dimColor={isHeader || (!isAdded && !isRemoved)}
          >
            {line}
          </Text>
        );
      })}
      {truncated && (
        <Text color={palette.secondary} dimColor>
          {"  "}…{allLines.length - MAX_DIFF_LINES} more lines
        </Text>
      )}
    </Box>
  );
}

// ── Input summarizer ───────────────────────────────────────────────────────

function summarizeInput(name: string, input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const o = input as Record<string, unknown>;
  switch (name) {
    case "bash":      return truncate((o["command"] as string | undefined) ?? "", 55);
    case "file_read":
    case "file_write":
    case "file_edit": return (o["path"] as string | undefined) ?? "";
    case "glob":      return (o["pattern"] as string | undefined) ?? "";
    case "grep":      return `/${truncate((o["pattern"] as string | undefined) ?? "", 40)}/`;
    case "web_fetch": return truncate((o["url"] as string | undefined) ?? "", 52);
    default: {
      const v = Object.values(o).find((x) => typeof x === "string");
      return typeof v === "string" ? truncate(v, 52) : "";
    }
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + symbols.ellipsis : s;
}
