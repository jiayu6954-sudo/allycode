/**
 * sessions subcommand — list past sessions.
 *
 * Usage:
 *   allycode sessions list   — show recent sessions with timestamps
 */

import { Command } from "commander";

export function sessionsCommand(): Command {
  const cmd = new Command("sessions").description("Manage AllyCode sessions");

  cmd
    .command("list")
    .description("List recent sessions")
    .action(async () => {
      const { listSessions } = await import("../../memory/session.js");
      const sessions = await listSessions();
      if (sessions.length === 0) {
        console.log("No sessions found.");
        return;
      }
      const recent = sessions.slice(0, 20);
      console.log(`Sessions (${sessions.length} total, showing last ${recent.length}):\n`);
      for (const session of recent) {
        const when = new Date(session.updatedAt).toLocaleString();
        console.log(`  ${session.id.slice(0, 8)}  ${when}  ${session.title ?? "(untitled)"}`);
      }
    });

  return cmd;
}
