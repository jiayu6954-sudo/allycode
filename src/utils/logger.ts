import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Respect ALLYCODE_DATA_DIR if set (same logic as config/settings.ts)
const _dataDir = (() => {
  const env = process.env["ALLYCODE_DATA_DIR"];
  return env && env.trim() ? path.resolve(env.trim()) : path.join(os.homedir(), ".allycode");
})();
const LOG_FILE = path.join(_dataDir, "debug.log");
const DEBUG = process.env["ALLYCODE_DEBUG"] === "1";

let logStream: fs.WriteStream | null = null;

function getStream(): fs.WriteStream {
  if (!logStream) {
    // Ensure directory exists synchronously at startup
    const dir = path.dirname(LOG_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
  }
  return logStream;
}

export const logger = {
  debug(msg: string, data?: unknown): void {
    if (!DEBUG) return;
    const line = `[DEBUG ${new Date().toISOString()}] ${msg}${data !== undefined ? " " + JSON.stringify(data) : ""}\n`;
    getStream().write(line);
  },

  info(msg: string, data?: unknown): void {
    const line = `[INFO  ${new Date().toISOString()}] ${msg}${data !== undefined ? " " + JSON.stringify(data) : ""}\n`;
    getStream().write(line);
  },

  warn(msg: string, data?: unknown): void {
    const line = `[WARN  ${new Date().toISOString()}] ${msg}${data !== undefined ? " " + JSON.stringify(data) : ""}\n`;
    getStream().write(line);
  },

  error(msg: string, err?: unknown): void {
    const errStr =
      err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : JSON.stringify(err);
    const line = `[ERROR ${new Date().toISOString()}] ${msg}${err !== undefined ? " " + errStr : ""}\n`;
    getStream().write(line);
  },

  close(): void {
    if (logStream) {
      logStream.end();
      logStream = null;
    }
  },
};
