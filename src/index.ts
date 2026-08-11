import { program } from "commander";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { loadSettings, applyCliOverrides, ensureConfigDir } from "./config/settings.js";
import { runCommand } from "./cli/commands/run.js";
import { configCommand } from "./cli/commands/config.js";
import { sessionsCommand } from "./cli/commands/sessions.js";

// Read package.json for version
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let version = "0.1.0";
try {
  // Works in both dev (src/) and built (dist/) environments
  const pkgPath = path.resolve(__dirname, "..", "package.json");
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { version: string };
    version = pkg.version;
  }
} catch {
  // Use default
}

async function main(): Promise<void> {
  await ensureConfigDir();
  // Keep options that appear after a subcommand with that subcommand. Without
  // this, root --model silently swallowed `config test --model ...`.
  program.enablePositionalOptions();

  // I023: initialise default skill files on first run (non-blocking)
  import("./skills/loader.js").then(({ initDefaultSkills }) => {
    try { initDefaultSkills(); } catch { /* non-fatal */ }
  }).catch(() => {});

  // I016: run storage guard on every startup (non-blocking, errors swallowed)
  import("./storage/guard.js").then(({ runStorageGuard }) => {
    void runStorageGuard();
  }).catch(() => { /* non-fatal */ });

  program
    .name("allycode")
    .version(version)
    .description("AllyCode — AI coding assistant with long-term memory and multi-provider support")
    .argument("[prompt]", "Prompt to run (non-interactive if stdin is a pipe)")
    .option("-m, --model <model>", "Model: claude-sonnet-4-6 | claude-opus-4-6")
    .option("--max-tokens <n>", "Max output tokens", parseInt)
    .option("--allow-all", "Auto-approve all tool permissions")
    .option("--deny-all", "Deny write/exec permissions (read-only mode)")
    .option("--session <id>", "Resume a previous session by ID prefix")
    .option("--cwd <path>", "Working directory (default: current directory)")
    .option("--api-key <key>", "Anthropic API key (overrides ANTHROPIC_API_KEY env)")
    .option("--verbose", "Enable debug logging to ~/.allycode/debug.log")
    .action(async (prompt: string | undefined, opts: {
      model?: string;
      maxTokens?: number;
      allowAll?: boolean;
      denyAll?: boolean;
      session?: string;
      cwd?: string;
      apiKey?: string;
      verbose?: boolean;
    }) => {
      if (opts.verbose) {
        process.env["ALLYCODE_DEBUG"] = "1";
      }

      // Strip invisible Unicode control characters from cwd (e.g. \u202a LTR embedding
      // that terminals sometimes inject, which breaks path.resolve on Windows).
      if (opts.cwd) {
        opts.cwd = opts.cwd.replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, "").trim();
      }

      const settings = applyCliOverrides(await loadSettings(), {
        model: opts.model,
        maxTokens: opts.maxTokens,
        allowAll: opts.allowAll,
        denyAll: opts.denyAll,
        apiKey: opts.apiKey,
      });

      // Determine mode: interactive REPL vs pipe/headless
      const isInteractive = process.stdin.isTTY && process.stdout.isTTY;

      if (isInteractive) {
        // Lazy-load Ink (heavy dep, only needed for interactive mode)
        const { chatCommand } = await import("./cli/commands/chat.js");
        await chatCommand({ prompt, settings, opts });
      } else {
        await runCommand({ prompt, settings, opts });
      }
    });

  program.addCommand(configCommand());
  program.addCommand(sessionsCommand());

  program
    .command("setup")
    .description("Interactive setup wizard — configure API key and model")
    .action(async () => {
      const { runSetupWizard } = await import("./config/setup.js");
      await runSetupWizard();
    });

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
