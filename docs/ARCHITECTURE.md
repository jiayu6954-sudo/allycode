# AllyCode architecture

## System overview

AllyCode is one agent runtime exposed through three delivery surfaces:

1. Electron desktop application.
2. Ink terminal application.
3. Headless CLI for pipes and automation.

All surfaces share the same source modules under `src/`; the desktop orchestration layer under `desktop/` adapts them to secure Electron IPC.

## Layers

### Entry and presentation

- `src/index.ts`: Commander entry point, runtime initialization, CLI mode selection.
- `src/ui/`: Ink terminal renderer and agent-loop hook.
- `desktop/main.ts`: Electron lifecycle and IPC handlers.
- `desktop/preload.ts`: context-isolated renderer bridge.
- `desktop/renderer/`: React workspace, sessions, chat, activity, permissions, and settings.

### Agent runtime

- `src/agent/loop.ts`: iterative model/tool loop, parallel tool execution, usage accounting, checkpoints, error limits, and token budgets.
- `src/agent/stream.ts`: provider-neutral delta processing.
- `src/agent/context.ts`: history and compaction support.
- `src/agent/research-loop.ts`: isolated web research loop with restricted tools.
- `src/agent/system-prompt.ts`: identity, safety, environment, memory, project context, skills, and command hints.

### Provider abstraction

`src/providers/interface.ts` defines provider-neutral stream and final-message shapes.

- `anthropic.ts`: Anthropic Messages API.
- `openai-compatible.ts`: OpenAI, DeepSeek, Groq, Gemini, OpenRouter, Moonshot, and custom endpoints.
- `local.ts`: local endpoint discovery, capability probing, native tools, and XML fallback.
- `index.ts`: provider selection and credential resolution.

Provider streams must propagate network/parser errors to both delta consumers and `finalMessage()`. A successful empty response is treated as an error.

### Tools and permissions

`ToolRegistry` combines native tools and MCP tools, validates inputs with Zod, runs hooks, caps output, and manages the per-session cache.

Dedicated host file tools call `resolveWorkspacePath`, which enforces lexical and real-path containment. `PermissionManager` applies static denies, session allowances, automatic policy, and dangerous-action prompts.

The shell can optionally use `SandboxManager`. Strict mode always disables container networking.

### MCP

`MCPRegistry` connects all configured servers and namespaces tools as `server__tool`.

- `StdioMCPClient`: newline-framed JSON-RPC over a managed process.
- `HttpMCPClient`: Streamable HTTP with JSON or single-event SSE responses.

Both transports send `notifications/initialized`; requests time out after 30 seconds.

### Persistence

Runtime data lives under `ALLYCODE_DATA_DIR` or `~/.allycode/`.

- `settings.json`: validated Zod settings.
- `sessions/*.json`: complete conversation history and usage.
- `memory/`: user and project Markdown memory.
- `memory/vectors.json`: versioned vector chunks with content hashes.
- `skills/*.md`: user workflow skills.
- `debug.log`: structured diagnostic lines.

Session IDs support unique prefixes. Storage guard quotas are enforced at startup.

### Semantic memory

Ollama embeddings are persisted and re-indexed only when content hashes change. TF-IDF vocabulary is process-local, so persisted TF-IDF vectors are discarded at initialization and rebuilt in one vocabulary space. User memory is stored under a global project ID; project context, decisions, and learnings remain project-scoped.

## Desktop event flow

```text
Renderer submit
  -> IPC agent:start
  -> DesktopAgentService
  -> load settings/session/context
  -> connect MCP and build tools
  -> runAgentLoop
  -> agent:event deltas/tool activity/permission
  -> renderer updates active assistant by stable message ID
  -> save complete updatedHistory
```

Permission requests are promises owned by the main process. Aborting a run denies any pending request before aborting the model/tool loop.

## Build outputs

- `dist/index.js`: CLI bundle.
- `dist-desktop/main.js`: Electron main process bundle.
- `dist-desktop/preload.cjs`: sandbox-compatible preload.
- `dist-desktop/renderer/`: Vite production renderer.
- `release/`: electron-builder Windows installers.
