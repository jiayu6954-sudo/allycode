import { render } from "ink";
import React from "react";
import { App } from "./app.js";
import type { DevAISettings } from "../types/config.js";

interface RenderOptions {
  settings:       DevAISettings;
  cwd:            string;
  initialPrompt?: string;
  sessionId?:     string;
}

/**
 * Mouse scroll callback registered by App to update scroll state.
 */
export type MouseScrollCallback = (direction: "up" | "down") => void;
let _mouseScrollCb: MouseScrollCallback | null = null;

export function setMouseScrollCallback(cb: MouseScrollCallback): void {
  _mouseScrollCb = cb;
}

/**
 * Shift+Enter flag: set by stdin patch when Shift+Enter escape sequence is
 * detected, read-and-cleared by InputBar's key.return handler to insert a
 * newline instead of submitting.
 */
export let _shiftEnterPending = false;
export function consumeShiftEnter(): boolean {
  const v = _shiftEnterPending;
  _shiftEnterPending = false;
  return v;
}

export function renderApp(opts: RenderOptions): void {
  // Primary buffer (NOT alternate screen).
  // Alt-screen (\x1b[?1049h) was removed because:
  //   1. It destroys terminal scrollback → user cannot scroll up to read history
  //   2. In alt-screen the cursor stops in the middle of the viewport after
  //      Static items are written; the streaming zone appears as a small
  //      "floating box" in the middle rather than anchored at the bottom
  //   3. Static + alt-screen causes cursor-tracking desync once content
  //      exceeds termRows, producing jitter that worsens over time
  // In primary buffer, Static items go to scrollback (scrollable), the viewport
  // always shows the latest content, and cursor is at the terminal bottom.

  // ── Detect terminal capability ───────────────────────────────────────
  // Mouse mode (?1000h) works in Windows Terminal, ConEmu, xterm, etc.
  // In plain CMD / legacy PowerShell it has no effect but right-click
  // paste still works natively — so we only enable mouse in capable terms.
  // Detection: Windows Terminal sets WT_SESSION; ConEmu sets ConEmuPID.
  const hasMouseSupport =
    !!process.env["WT_SESSION"]   ||  // Windows Terminal
    !!process.env["ConEmuPID"]    ||  // ConEmu / cmder
    !!process.env["TERM_PROGRAM"] ||  // macOS Terminal, iTerm2, etc.
    process.platform !== "win32";    // Linux / macOS always capable

  if (hasMouseSupport) {
    // SGR mouse: button events + extended encoding for wheel scrolling
    process.stdout.write("\x1b[?1000h\x1b[?1006h");
    // Bracketed paste: wraps pasted text in \x1b[200~ ... \x1b[201~
    process.stdout.write("\x1b[?2004h");
  }

  // ── Keyboard modifier reporting ──────────────────────────────────────
  // Enables Shift+Enter to be distinguishable from plain Enter.
  // Two protocols for maximum terminal coverage:
  //   \x1b[>1u   kitty progressive enhancement (Windows Terminal, WezTerm, …)
  //              Shift+Enter → \x1b[13;2u
  //   \x1b[>4;1m xterm modifyOtherKeys mode 1 (xterm, GNOME Terminal, …)
  //              Shift+Enter → \x1b[27;2;13~
  process.stdout.write("\x1b[>1u\x1b[>4;1m");

  // ── Filter mouse sequences at the stream push level ──────────────────
  //
  // Node.js streams receive OS data via an internal push(chunk) call which
  // then triggers 'data' events. By patching push we intercept BEFORE
  // readline / Ink ever see the bytes — no garbage in the input box.
  //
  // We keep Ink pointing at the real process.stdin (preserving all TTY
  // properties) so startup never crashes.
  const stdin = process.stdin as any;
  const origPush = stdin.push.bind(stdin) as (chunk: Buffer | null, enc?: BufferEncoding) => boolean;

  // Buffer for assembling bracketed paste across multiple push() calls
  let pasteBuffer = "";
  let inPaste     = false;

  stdin.push = function (chunk: Buffer | null, enc?: BufferEncoding): boolean {
    if (chunk) {
      const raw = chunk.toString("binary");

      // ── SGR mouse sequences ─────────────────────────────────────────
      if (raw.includes("\x1b[<")) {
        const escape = String.fromCharCode(27);
        const m = raw.match(new RegExp(`${escape}\\[<(6[45]);`));
        if (m && _mouseScrollCb) {
          _mouseScrollCb(m[1] === "64" ? "up" : "down");
        }
        return true; // consumed — no 'data' event fires
      }

      // ── Bracketed paste ─────────────────────────────────────────────
      // Terminals wrap pasted text: \x1b[200~ {content} \x1b[201~
      // We accumulate everything between the markers and emit it as plain
      // characters so InputBar inserts it normally.
      if (raw.includes("\x1b[200~") || inPaste) {
        pasteBuffer += raw;
        if (!inPaste) inPaste = true;

        if (pasteBuffer.includes("\x1b[201~")) {
          // Full paste received — extract the content between markers
          const start = pasteBuffer.indexOf("\x1b[200~") + "\x1b[200~".length;
          const end   = pasteBuffer.indexOf("\x1b[201~");
          const text  = pasteBuffer.slice(start, end);
          pasteBuffer = "";
          inPaste     = false;
          if (text) return origPush(Buffer.from(text, "binary"), enc);
          return true;
        }
        return true; // waiting for end marker
      }

      // ── Shift+Enter ─────────────────────────────────────────────────
      // kitty:  \x1b[13;2u      xterm modifyOtherKeys: \x1b[27;2;13~
      // Strategy: set a global flag, then emit \r (plain Enter byte).
      // Ink fires key.return=true; InputBar reads the flag to decide
      // whether to insert a newline or submit. Flag is reset each time.
      if (raw.includes("\x1b[13;2u") || raw.includes("\x1b[27;2;13~")) {
        _shiftEnterPending = true;
        return origPush(Buffer.from("\r"), enc);
      }
    }
    return origPush(chunk, enc);
  };

  const cleanup = (): void => {
    stdin.push = origPush;
    process.stdout.write("\x1b[<u");                // kitty: pop keyboard mode
    process.stdout.write("\x1b[>4;0m");             // xterm: reset modifyOtherKeys
    if (hasMouseSupport) {
      process.stdout.write("\x1b[?2004l");            // disable bracketed paste
      process.stdout.write("\x1b[?1000l\x1b[?1006l"); // disable mouse
    }
    // (no alternate screen to exit)
  };

  process.on("exit",    cleanup);
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });

  const { waitUntilExit } = render(
    React.createElement(App, {
      settings:      opts.settings,
      cwd:           opts.cwd,
      initialPrompt: opts.initialPrompt,
      sessionId:     opts.sessionId,
    }),
    { exitOnCtrlC: false }
  );

  waitUntilExit()
    .then(()  => { cleanup(); process.exit(0); })
    .catch(() => { cleanup(); process.exit(1); });
}
