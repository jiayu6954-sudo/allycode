import { execa } from "execa";
import type {
  JSONRPCRequest,
  JSONRPCResponse,
  JSONRPCNotification,
  MCPTool,
  MCPToolResult,
  MCPServerConfig,
  MCPInitializeResult,
  MCPClient,
} from "./types.js";
import { logger } from "../utils/logger.js";

type ExecaProcess = ReturnType<typeof execa>;
const MCP_REQUEST_TIMEOUT_MS = 30_000;

/**
 * MCP stdio transport client.
 *
 * Implements JSON-RPC 2.0 over stdin/stdout with newline framing.
 * One instance = one MCP server connection.
 */
export class StdioMCPClient implements MCPClient {
  private process: ExecaProcess | null = null;
  private buffer = "";
  private nextId = 1;
  private pendingRequests = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
  }>();

  constructor(private config: MCPServerConfig) {}

  async connect(): Promise<void> {
    if (!this.config.command) {
      throw new Error(`MCP server '${this.config.name}': stdio transport requires 'command'`);
    }

    this.process = execa(this.config.command, this.config.args ?? [], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...(this.config.env ?? {}) },
    });

    // Suppress unhandled rejection when we intentionally kill the process
    // (execa v9 wraps the process in a Promise that rejects on SIGTERM)
    this.process.catch(() => {});

    this.process.stdout!.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      this.processBuffer();
    });

    // Drain stderr to prevent backpressure; log at debug level
    this.process.stderr!.on("data", (chunk: Buffer) => {
      logger.debug(`mcp.${this.config.name}.stderr`, { msg: chunk.toString().trim() });
    });

    // 'close' fires after all stdio streams have ended — safe to clean up then
    this.process.on("close", (code: number | null) => {
      logger.debug(`mcp.${this.config.name}.close`, { code });
      this.cleanup(new Error(`MCP server '${this.config.name}' exited (code ${code})`));
    });

    this.process.on("error", (err: Error) => {
      logger.error(`mcp.${this.config.name}.error`, err);
      this.cleanup(err);
    });

    await this.initialize();
    this.notify("notifications/initialized", {});
  }

  async disconnect(): Promise<void> {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.cleanup(new Error(`MCP server '${this.config.name}' disconnected`));
  }

  async listTools(): Promise<MCPTool[]> {
    const result = await this.request<{ tools: MCPTool[] }>("tools/list", {});
    return result.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    return this.request<MCPToolResult>("tools/call", { name, arguments: args });
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private async initialize(): Promise<MCPInitializeResult> {
    return this.request<MCPInitializeResult>("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "allycode", version: "0.10.0" },
    });
  }

  private async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (!this.process?.stdin) {
      throw new Error(`MCP server '${this.config.name}' is not connected`);
    }

    const id = this.nextId++;
    const message: JSONRPCRequest = { jsonrpc: "2.0", id, method, params };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(
          `MCP request timed out after ${MCP_REQUEST_TIMEOUT_MS / 1000}s: ${method}`,
        ));
      }, MCP_REQUEST_TIMEOUT_MS);
      this.pendingRequests.set(id, {
        resolve: ((value: unknown) => {
          clearTimeout(timer);
          resolve(value as T);
        }),
        reject: (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.process!.stdin!.write(JSON.stringify(message) + "\n");
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    if (!this.process?.stdin) return;
    const message: JSONRPCNotification = { jsonrpc: "2.0", method, params };
    this.process.stdin.write(JSON.stringify(message) + "\n");
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    // Keep the last (possibly incomplete) line in the buffer
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) this.handleMessage(line);
    }
  }

  private handleMessage(raw: string): void {
    let msg: JSONRPCResponse | JSONRPCNotification;
    try {
      msg = JSON.parse(raw) as JSONRPCResponse | JSONRPCNotification;
    } catch {
      logger.debug(`mcp.${this.config.name}.parse_error`, { raw });
      return;
    }

    // Notifications have no id — ignore them (we don't subscribe to any)
    if (!("id" in msg)) return;

    const response = msg as JSONRPCResponse;
    const pending = this.pendingRequests.get(response.id);
    if (!pending) return;

    this.pendingRequests.delete(response.id);

    if (response.error) {
      pending.reject(new Error(`MCP error ${response.error.code}: ${response.error.message}`));
    } else {
      pending.resolve(response.result);
    }
  }

  private cleanup(err: Error): void {
    for (const { reject } of this.pendingRequests.values()) {
      reject(err);
    }
    this.pendingRequests.clear();
  }
}
