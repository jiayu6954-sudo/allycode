/**
 * run command — non-interactive (headless/pipe) mode.
 *
 * Used when stdin or stdout is not a TTY (e.g. piped input, CI scripts).
 * Runs a single agent loop turn and prints the response to stdout.
 * All tool permissions auto-approved ("allow") in headless mode.
 */

import type { AllyCodeSettings } from "../../config/schema.js";
import type { AgentEvent } from "../../types/agent.js";

interface RunCommandOptions {
  prompt?:   string;
  settings:  AllyCodeSettings;
  opts: {
    cwd?: string;
  };
}

export async function runCommand({ prompt, settings, opts }: RunCommandOptions): Promise<void> {
  if (!prompt) {
    console.error("No prompt provided. Usage: allycode <prompt>");
    process.exit(1);
  }

  const nodePath = await import("node:path");
  const cwd = opts.cwd ? nodePath.resolve(opts.cwd) : process.cwd();

  const [
    { createProvider },
    { buildSystemPrompt },
    { runAgentLoop },
    { ToolRegistry },
    { PermissionManager },
    { SessionStats },
  ] = await Promise.all([
    import("../../providers/index.js"),
    import("../../agent/system-prompt.js"),
    import("../../agent/loop.js"),
    import("../../tools/registry.js"),
    import("../../permissions/manager.js"),
    import("../../utils/stats.js"),
  ]);

  const provider    = createProvider(settings);
  const tools       = new ToolRegistry(cwd);
  // Headless mode: auto-approve all tool calls
  const permissions = new PermissionManager(settings, async () => "allow");
  const stats       = new SessionStats();
  const systemPrompt = await buildSystemPrompt(cwd, null, settings);

  const ac = new AbortController();
  process.on("SIGINT",  () => ac.abort());
  process.on("SIGTERM", () => ac.abort());

  const onEvent = (event: AgentEvent): void => {
    if (event.type === "text_delta") {
      process.stdout.write(event.delta);
    } else if (event.type === "tool_start") {
      process.stderr.write(`\n[tool: ${event.toolName}]\n`);
    } else if (event.type === "done") {
      process.stdout.write("\n");
    }
  };

  try {
    await runAgentLoop(
      provider,
      {
        model:               settings.model,
        maxTokens:           settings.maxTokens,
        systemPrompt,
        conversationHistory: [{ role: "user", content: [{ type: "text", text: prompt }] }],
        signal:              ac.signal,
        onEvent,
        tokenBudget: {
          warningThreshold: settings.tokenBudget.warningThreshold,
          hardLimit:        settings.tokenBudget.hardLimit,
          priorTokens:      0,
        },
      },
      tools,
      permissions,
      stats,
    );
  } catch (err) {
    if ((err as Error)?.name !== "AbortError") {
      console.error((err as Error)?.message ?? String(err));
      process.exit(1);
    }
  }
}
