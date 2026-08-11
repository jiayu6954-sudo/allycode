# AllyCode

[![CI](https://github.com/jiayu6954-sudo/allycode/actions/workflows/ci.yml/badge.svg)](https://github.com/jiayu6954-sudo/allycode/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](LICENSE)
[![Node.js 22.5+](https://img.shields.io/badge/Node.js-22.5%2B-black.svg)](package.json)

AllyCode is a TypeScript AI coding assistant with both a terminal interface and an Electron desktop application. It supports multiple model providers, tool permissions, project-scoped file operations, MCP servers, long-term memory, research tasks, and an optional Docker shell sandbox.

Current version: `0.10.0-alpha.8`

> AllyCode is alpha software. Review tool requests, keep backups, and do not use unrestricted permissions on untrusted repositories.

## What is included

- Desktop workspace with project tree, durable tasks, pause/resume checkpoints, project memory, streamed chat, tool activity, permission dialogs, and provider settings.
- Interactive Ink terminal UI and non-interactive CLI mode.
- Anthropic, OpenAI, DeepSeek, Alibaba Qwen, Groq, Gemini, OpenRouter, Moonshot/Kimi, custom OpenAI-compatible endpoints, and local Ollama-compatible models.
- Native tools for files, search, shell commands, Git commits, web retrieval, and isolated research.
- MCP over stdio and Streamable HTTP, including initialization notification and request timeouts.
- Durable SQLite WAL task journal with project-scoped history search and crash recovery.
- Layered long-term memory with semantic retrieval, visible project memory, and an offline TF-IDF fallback.
- Optional persistent per-task Docker sandbox with non-root execution, capability removal, resource limits, and strict offline mode.
- Self-hosted SearXNG support for private or regionally available web search.
- Per-session tool-result cache and bounded runtime storage.

## Requirements

- Node.js 22.5 or newer for the CLI. The packaged desktop application includes its own compatible runtime.
- Docker Desktop only when the optional shell sandbox is enabled.
- An API key for the selected cloud provider, or a running local model service.

## Run from source

```bash
npm ci
npm run typecheck
npm run typecheck:desktop
npm run lint
npm run test:run
npm run build
```

Start the terminal application:

```bash
npm link
allycode setup
allycode
```

Start the desktop application:

```bash
npm run desktop
```

Build Windows installers:

```bash
npm run desktop:package
```

Artifacts are written to `release/`.

`desktop:package` creates an unsigned local preview. A distributable release is deliberately gated:

```powershell
$env:WIN_CSC_LINK = "<certificate-or-secure-url>"
$env:WIN_CSC_KEY_PASSWORD = "<certificate-password>"
$env:ALLYCODE_PRIMARY_UPDATE_URL = "https://<domestic-primary>/allycode/alpha"
$env:ALLYCODE_MIRROR_UPDATE_URL = "https://<domestic-mirror>/allycode/alpha"
npm run desktop:release
```

The release command refuses to run without a signing certificate and two distinct HTTPS update origins. It verifies Authenticode signatures and writes a SHA-256 manifest after packaging.

## CLI

```bash
allycode "explain this repository"
allycode --cwd D:/work/project "fix the failing tests"
allycode --session a1b2c3d4
allycode --deny-all "review this code"
allycode sessions list
```

Configuration:

```bash
allycode config show
allycode config show --json
allycode config show --storage
allycode config set ui.theme dark
allycode config set sandbox.enabled true
allycode config model --provider deepseek --model deepseek-chat
allycode config reset --yes
```

Settings and runtime data are stored in `~/.allycode/`. Set `ALLYCODE_DATA_DIR` to relocate all settings, sessions, logs, memory, and skills:

```powershell
$env:ALLYCODE_DATA_DIR = "D:\allycode-data"
allycode
```

On first launch, AllyCode copies an existing `~/.seed/` data directory to `~/.allycode/` without deleting the legacy directory.

## Provider credentials

Environment variables are supported:

| Provider | Variable |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| Alibaba Qwen | `DASHSCOPE_API_KEY` |
| Groq | `GROQ_API_KEY` |
| Gemini | `GEMINI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Moonshot | `MOONSHOT_API_KEY` |

In the desktop application, credentials are encrypted with Electron `safeStorage` (Windows DPAPI on Windows) and written to `~/.allycode/credentials.secure.json`. Existing desktop credentials are migrated by encrypting first and removing plaintext from `settings.json` only after the encrypted write succeeds. The renderer receives only credential-present status, never a stored secret. Environment variables remain supported for CLI and managed deployments.

Fresh desktop installations start with DeepSeek and `deepseek-chat`, then show a three-step Chinese setup wizard for DeepSeek, Alibaba Qwen, or Moonshot/Kimi. The wizard links to the official key console and performs a real provider compatibility test before completion.

## Architecture

```text
Terminal UI ─┐
Desktop UI ──┼─> Agent loop ─> Provider adapter ─> model API/local model
Headless CLI ┘       │
                    ├─> Permission manager ─> native tools
                    ├─> MCP registry ─> stdio / Streamable HTTP servers
                    ├─> Session store
                    └─> Long-term memory / semantic retrieval
```

The terminal and desktop surfaces share the same provider, agent, permission, tool, memory, MCP, sandbox, and session layers. See [Architecture](docs/ARCHITECTURE.md) and [Agent platform architecture](docs/AGENT_PLATFORM_ARCHITECTURE.md).

## Safety model

- File read/write/edit/glob/grep paths are checked both lexically and through existing symbolic-link ancestors so they remain inside the selected workspace.
- Shell and write operations use configurable permission levels: `auto`, `ask`, or `deny`.
- Dangerous actions always prompt unless statically denied.
- Strict Docker sandbox mode disables networking regardless of the general network setting.
- Hook variables are shell-quoted, but hooks intentionally execute on the host and should be treated as trusted configuration.
- Cloud metadata endpoints are blocked by `web_fetch`.
- Settings output redacts key/token fields.

Read [SECURITY.md](SECURITY.md) before using AllyCode with unfamiliar code.

## Storage limits

The startup storage guard enforces:

| Data | Limit |
|---|---:|
| Sessions | 100 |
| Debug log | 10 MB, trimmed to about 5 MB |
| Vector store | 200 MB |
| Total data directory | 2 GB |

Inspect usage with `allycode config show --storage`.

## Development checks

```bash
npm run lint
npm run typecheck
npm run typecheck:desktop
npm run test:run
npm run build
npm audit --omit=dev
```

The regression suite covers long-term memory, the agent/tool loop, research result propagation, provider stream failures, session prefix loading, nested configuration, workspace boundaries, and shared tool-cache lifetime.

## Project status

AllyCode is under active alpha development. The public source is suitable for review,
experimentation, and contributions, but it should not be treated as a production
security boundary. Signed installers and update infrastructure are maintainer-operated
release concerns and are not embedded in the repository.

See [CHANGELOG.md](CHANGELOG.md) for release notes, [CONTRIBUTING.md](CONTRIBUTING.md)
for development guidelines, and [SECURITY.md](SECURITY.md) for private vulnerability
reporting.

## License

MIT. See [LICENSE](LICENSE).
