/**
 * Design system — single source of truth for all UI colors, symbols, and themes.
 *
 * v0.7.0 fusion upgrade: merged Claude Code's explicit-RGB color philosophy
 * with devai's warm allycode aesthetic. Key changes:
 *   - Explicit rgb() values (avoids terminal ANSI override inconsistencies)
 *   - CC-sourced diff colors (soft green/red instead of harsh primaries)
 *   - Platform-specific ● bullet (⏺ macOS / ● Linux+Win)
 *   - Brighter primary text for readability
 *   - Retained: warm cream / gold accent / allycode brand identity
 *
 * Two themes:
 *   dark  (default) — warm cream on dark terminal background
 *   light           — warm near-black on light terminal background
 */

import React from "react";

// Platform-specific status bullet — matches Claude Code's figures.ts convention
// macOS ⏺ is vertically better aligned; ● works everywhere else
export const BULLET = process.platform === "darwin" ? "⏺" : "●";

// ── Dark theme (default) ──────────────────────────────────────────────────
export const darkPalette = {
  // Text hierarchy
  // v0.7.0: bumped from #B8B3A8 (too muted) to a crisper warm cream
  primary:   "rgb(210,204,196)",  // Warm cream — clear and readable
  secondary: "rgb(108,103,98)",   // Warm medium gray — recedes into background
  accent:    "rgb(210,165,55)",   // Seed gold — active state, cursor, interactive

  // Semantic
  error:     "rgb(171,43,63)",    // CC-sourced muted red
  warning:   "rgb(150,108,30)",   // CC-sourced amber
  success:   "rgb(44,122,57)",    // CC-sourced forest green (success state)

  // Brand — devai's unique warm orange (inspired by Claude's rgb(215,119,87))
  // Used for the assistant label and brand moments
  brand:     "rgb(200,130,80)",   // Warm seed-sprout orange

  // Diff colors — sourced directly from CC's theme.ts
  diffAdded:         "rgb(105,219,124)",  // Soft light green
  diffRemoved:       "rgb(255,168,180)",  // Soft light red/pink
  diffAddedDimmed:   "rgb(199,225,203)",  // Very muted green (context lines)
  diffRemovedDimmed: "rgb(253,210,216)",  // Very muted red (context lines)

  // Tool status (maps to palette keys used in ToolCall.tsx)
  toolRunning: "rgb(210,165,55)",   // Gold while running — matches accent
  toolSuccess: "rgb(44,122,57)",    // Green on success
  toolError:   "rgb(171,43,63)",    // Red on error
  toolDenied:  "rgb(108,103,98)",   // Gray — denied fades away

  // Risk levels
  riskSafe:      "rgb(108,103,98)",
  riskModerate:  "rgb(150,108,30)",
  riskDangerous: "rgb(171,43,63)",

  // App state
  stateIdle:      "rgb(108,103,98)",
  stateStreaming: "rgb(210,165,55)",
  stateError:     "rgb(171,43,63)",
} as const;

// ── Light theme ───────────────────────────────────────────────────────────
export const lightPalette = {
  primary:   "rgb(28,25,23)",     // Warm near-black
  secondary: "rgb(87,83,78)",     // Stone-600
  accent:    "rgb(146,64,14)",    // Amber-800 — dark gold on light bg
  error:     "rgb(155,28,28)",    // Red-900
  warning:   "rgb(146,64,14)",
  success:   "rgb(20,83,45)",     // Dark green

  brand:     "rgb(180,90,45)",    // Warm orange on light bg

  diffAdded:         "rgb(47,157,68)",    // Richer green for light bg
  diffRemoved:       "rgb(209,69,75)",    // Richer red for light bg
  diffAddedDimmed:   "rgb(150,210,165)",
  diffRemovedDimmed: "rgb(240,175,180)",

  toolRunning: "rgb(146,64,14)",
  toolSuccess: "rgb(20,83,45)",
  toolError:   "rgb(155,28,28)",
  toolDenied:  "rgb(87,83,78)",

  riskSafe:      "rgb(87,83,78)",
  riskModerate:  "rgb(146,64,14)",
  riskDangerous: "rgb(155,28,28)",

  stateIdle:      "rgb(87,83,78)",
  stateStreaming: "rgb(146,64,14)",
  stateError:     "rgb(155,28,28)",
} as const;

// Explicit interface so light/dark palettes are both assignable
export interface ThemePalette {
  primary: string;
  secondary: string;
  accent: string;
  error: string;
  warning: string;
  success: string;
  brand: string;
  diffAdded: string;
  diffRemoved: string;
  diffAddedDimmed: string;
  diffRemovedDimmed: string;
  toolRunning: string;
  toolSuccess: string;
  toolError: string;
  toolDenied: string;
  riskSafe: string;
  riskModerate: string;
  riskDangerous: string;
  stateIdle: string;
  stateStreaming: string;
  stateError: string;
}

/** Backward-compatible default export — always dark palette */
export const palette: ThemePalette = darkPalette;

/** Resolve palette from user's theme setting. "auto" → dark. */
export function getPalette(theme: "dark" | "light" | "auto"): ThemePalette {
  return theme === "light" ? lightPalette : darkPalette;
}

// ── React context ──────────────────────────────────────────────────────────
export const ThemeContext = React.createContext<ThemePalette>(darkPalette);

export function useTheme(): ThemePalette {
  return React.useContext(ThemeContext);
}

// ── Symbols ────────────────────────────────────────────────────────────────
export const symbols = {
  // Separators
  dot:    "·",
  pipe:   "│",
  dash:   "─",
  heavy:  "━",   // CC: HEAVY_HORIZONTAL — used for status bar divider
  bullet: BULLET, // Platform-specific ● / ⏺
  blockquote: "▎", // CC: BLOCKQUOTE_BAR

  // Status icons — v0.7.0: single-bullet system like CC
  // The ● changes color: gold=running, green=success, red=error, gray=denied
  pending: "○",    // Not started
  running: BULLET, // Active — will be animated gold in ToolCall
  success: BULLET, // Done — static green
  error:   BULLET, // Failed — static red
  denied:  "⊘",    // Permission denied

  // UI chrome
  prompt:   "›",
  promptAlt: "▸",  // CC-style alternative prompt indicator
  cursor:   "▊",
  arrow:    "→",
  ellipsis: "…",
  sparkle:  "◆",   // devai allycode marker — KEEP (brand identity)

  // Effort / progress (from CC's figures.ts)
  effortLow:  "○",
  effortMed:  "◐",
  effortHigh: "●",
  effortMax:  "◉",

  // Tool type icons — dim category hint shown before tool name
  // Retained from devai's original design — unique visual language
  toolBash:      "$",   // shell command
  toolFileRead:  "≡",   // three lines = file content
  toolFileWrite: "+",   // create / add
  toolFileEdit:  "✎",   // pencil = edit (upgraded from ~)
  toolGlob:      "∗",   // asterisk = pattern match
  toolGrep:      "/",   // regex delimiter
  toolWebFetch:  "↗",   // outbound = up-right arrow
  toolMcp:       "⊕",   // external protocol = circled plus

  // Risk level icons
  riskSafe:      "◎",
  riskModerate:  "⚠",
  riskDangerous: "✖",

  // Additional UI chrome
  shield:   "◈",
  clock:    "◷",
  memory:   "◉",
  download: "↓",
  upload:   "↑",
} as const;

/** Risk level → palette color. */
export function riskColor(
  level: "safe" | "moderate" | "dangerous",
  p: ThemePalette = darkPalette
): string {
  return level === "dangerous" ? p.riskDangerous
    : level === "moderate" ? p.riskModerate
    : p.riskSafe;
}
