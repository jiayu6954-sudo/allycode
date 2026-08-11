import { StdioMCPClient } from "./client.js";
import { HttpMCPClient } from "./http-client.js";
import type { MCPClient, MCPTool, MCPToolResult, MCPServerConfig } from "./types.js";
import type { ToolDefinition, ToolResult } from "../types/tools.js";
import { logger } from "../utils/logger.js";

/**
 * Separator between server namespace and tool name.
 * e.g. "notion__search_pages", "postgres__execute_query"
 */
export const MCP_NS_SEP = "__";

/**
 * Risk classification for MCP tools based on verb prefix.
 * read-like verbs → auto (no prompt); write-like verbs → ask (prompt user).
 */
const READ_VERBS = new Set(["list", "get", "search", "find", "query", "read", "describe", "show", "fetch"]);

function isReadTool(toolName: string): boolean {
  const verb = toolName.split("_")[0]?.toLowerCase() ?? "";
  return READ_VERBS.has(verb);
}

interface RegisteredMCPTool {
  client: MCPClient;
  serverName: string;
  tool: MCPTool;
}

/**
 * MCPRegistry manages connections to one or more MCP servers and exposes
 * their tools as ToolDefinition[] compatible with ToolRegistry.
 *
 * Naming convention: "{serverName}{MCP_NS_SEP}{originalToolName}"
 * e.g. notion__search_pages, postgres__execute_query
 */
export class MCPRegistry {
  private clients: MCPClient[] = [];
  private tools = new Map<string, RegisteredMCPTool>();

  /**
   * Connect to all configured MCP servers and populate the tool registry.
   * Failed servers are logged but do not abort startup.
   */
  async connect(configs: MCPServerConfig[]): Promise<void> {
    await Promise.allSettled(
      configs.map((cfg) => this.connectOne(cfg))
    );
  }

  async disconnect(): Promise<void> {
    await Promise.allSettled(this.clients.map((c) => c.disconnect()));
    this.clients = [];
    this.tools.clear();
  }

  /** Returns ToolDefinition[] for all MCP tools, ready to merge into ToolRegistry */
  getToolDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.entries()).map(([qualifiedName, { tool }]) => ({
      name: qualifiedName as ToolDefinition["name"],
      description: tool.description ?? `${qualifiedName} (MCP tool)`,
      input_schema: tool.inputSchema as ToolDefinition["input_schema"],
    }));
  }

  /** Returns permission risk level for a qualified MCP tool name */
  getRiskLevel(qualifiedName: string): "safe" | "moderate" | "dangerous" {
    const localName = qualifiedName.split(MCP_NS_SEP).slice(1).join(MCP_NS_SEP);
    return isReadTool(localName) ? "safe" : "moderate";
  }

  /** Returns true if this registry owns the given qualified tool name */
  hasTool(qualifiedName: string): boolean {
    return this.tools.has(qualifiedName);
  }

  /** Execute an MCP tool by qualified name */
  async execute(qualifiedName: string, args: Record<string, unknown>): Promise<ToolResult> {
    const entry = this.tools.get(qualifiedName);
    if (!entry) {
      return { content: `Unknown MCP tool: ${qualifiedName}`, isError: true };
    }

    try {
      const result: MCPToolResult = await entry.client.callTool(entry.tool.name, args);

      const text = result.content
        .map((c) => (c.type === "text" ? c.text : `[image: ${c.mimeType}]`))
        .join("\n");

      return { content: text, isError: result.isError ?? false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`mcp.execute.${qualifiedName}`, err);
      return { content: `MCP tool error: ${msg}`, isError: true };
    }
  }

  /** Number of successfully connected MCP tools */
  get toolCount(): number {
    return this.tools.size;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async connectOne(cfg: MCPServerConfig): Promise<void> {
    const client: MCPClient =
      cfg.transport === "http"
        ? new HttpMCPClient(cfg)
        : new StdioMCPClient(cfg);
    try {
      await client.connect();
      const tools = await client.listTools();

      this.clients.push(client);
      for (const tool of tools) {
        const qualifiedName = `${cfg.name}${MCP_NS_SEP}${tool.name}`;
        this.tools.set(qualifiedName, { client, serverName: cfg.name, tool });
      }

      logger.debug("mcp.registry.connected", { name: cfg.name, tools: tools.length });
    } catch (err) {
      logger.error(`mcp.registry.connect_failed.${cfg.name}`, err);
      // Non-fatal: other servers continue working
    }
  }
}
