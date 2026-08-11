/**
 * chat command — interactive Ink TUI mode.
 *
 * Launched when stdin+stdout are both TTYs (interactive terminal).
 * Delegates all rendering to the Ink-based App component via renderApp().
 */

import type { AllyCodeSettings } from "../../config/schema.js";

interface ChatCommandOptions {
  prompt?:   string;
  settings:  AllyCodeSettings;
  opts: {
    session?: string;
    cwd?:     string;
  };
}

export async function chatCommand({ prompt, settings, opts }: ChatCommandOptions): Promise<void> {
  const { renderApp } = await import("../../ui/renderer.js");

  const cwd = opts.cwd
    ? (await import("node:path")).resolve(opts.cwd)
    : process.cwd();

  renderApp({
    settings,
    cwd,
    initialPrompt: prompt,
    sessionId:     opts.session,
  });
}
