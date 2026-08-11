import type {
  JSONRPCNotification,
  JSONRPCRequest,
  JSONRPCResponse,
  MCPClient,
  MCPInitializeResult,
  MCPServerConfig,
  MCPTool,
  MCPToolResult,
} from "./types.js";

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * MCP Streamable HTTP client. Supports JSON responses and the common
 * single-event SSE response shape used by Streamable HTTP servers.
 */
export class HttpMCPClient implements MCPClient {
  private nextId = 1;
  private sessionId: string | null = null;

  constructor(private config: MCPServerConfig) {}

  async connect(): Promise<void> {
    if (!this.config.url) {
      throw new Error(`MCP server '${this.config.name}': http transport requires 'url'`);
    }
    await this.request<MCPInitializeResult>("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "allycode", version: "0.10.0" },
    });
    await this.notify("notifications/initialized", {});
  }

  async disconnect(): Promise<void> {
    if (this.sessionId) {
      await fetch(this.config.url!, {
        method: "DELETE",
        headers: this.headers(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }).catch(() => undefined);
    }
    this.sessionId = null;
  }

  async listTools(): Promise<MCPTool[]> {
    const result = await this.request<{ tools?: MCPTool[] }>("tools/list", {});
    return result.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    return this.request<MCPToolResult>("tools/call", { name, arguments: args });
  }

  private async request<T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    const message: JSONRPCRequest = {
      jsonrpc: "2.0",
      id: this.nextId++,
      method,
      params,
    };
    const response = await this.post(message);
    if (!("id" in response)) throw new Error(`Invalid MCP response for ${method}`);
    if (response.error) {
      throw new Error(`MCP error ${response.error.code}: ${response.error.message}`);
    }
    return response.result as T;
  }

  private async notify(method: string, params: Record<string, unknown>): Promise<void> {
    const message: JSONRPCNotification = { jsonrpc: "2.0", method, params };
    await this.post(message, true);
  }

  private async post(
    message: JSONRPCRequest | JSONRPCNotification,
    notification = false,
  ): Promise<JSONRPCResponse | JSONRPCNotification> {
    const response = await fetch(this.config.url!, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const returnedSession = response.headers.get("mcp-session-id");
    if (returnedSession) this.sessionId = returnedSession;
    if (!response.ok) {
      throw new Error(`MCP HTTP ${response.status}: ${await response.text()}`);
    }
    if (notification || response.status === 202 || response.status === 204) {
      return { jsonrpc: "2.0", method: "accepted" };
    }
    const body = await response.text();
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      const dataLine = body
        .split(/\r?\n/)
        .find((line) => line.startsWith("data:"));
      if (!dataLine) throw new Error("MCP SSE response contained no data event");
      return JSON.parse(dataLine.slice(5).trim()) as JSONRPCResponse;
    }
    return JSON.parse(body) as JSONRPCResponse;
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
      ...(this.config.env ?? {}),
    };
  }
}
