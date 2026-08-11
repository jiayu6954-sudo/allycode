# AllyCode security

AllyCode can read and modify code, run commands, access configured MCP servers, and call external model APIs. Treat it as a powerful development tool, not as a security boundary.

## Supported versions

Security fixes are applied to the latest alpha release only.

## Permission model

Each native tool is configured as `auto`, `ask`, or `deny`. Dangerous operations are classified separately and prompt even when their broad tool category is automatic. `--deny-all` is the recommended mode for reviewing unfamiliar repositories.

MCP tools are namespaced by server. Read-like verbs are classified safe; other MCP operations are moderate and request approval.

## Workspace boundary

Host file tools resolve paths against the selected workspace. Both lexical traversal and symbolic-link ancestors that resolve outside the workspace are rejected.

This boundary applies to AllyCode's dedicated file tools. A user-approved host shell command can still access anything allowed to the operating-system account.

## Docker sandbox

When enabled, shell commands run in an ephemeral Docker container if Docker is available.

- `strict`: read-only workspace and no network.
- `standard`: writable workspace with configured network access.
- `permissive`: least restrictive container policy.

If Docker is unavailable, the terminal UI visibly warns that shell commands may fall back to the host. Host execution still goes through permission approval. Do not interpret the sandbox setting alone as proof that Docker isolation is active.

## Desktop isolation

The Electron renderer uses:

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`
- a narrow preload API
- external navigation denied in-app and opened through the operating system

The renderer cannot directly read files or spawn processes. It receives a redacted settings object through IPC; stored API keys and tokens are removed before the response crosses into the renderer.

## Hooks

Pre-tool and post-tool hooks intentionally execute shell commands on the host. Template variables are shell-quoted, but the hook command itself is trusted configuration. Never copy hook configuration from an untrusted repository into user settings.

## Secrets

Desktop credentials are encrypted with Electron `safeStorage` and stored separately
from ordinary settings. On Windows this uses the current user's DPAPI protection.
The renderer receives credential-presence status, never stored secret values. Legacy
desktop secrets are encrypted successfully before their plaintext settings fields are
removed.

Non-secret settings are stored at `~/.allycode/settings.json` or
`$ALLYCODE_DATA_DIR/settings.json`. POSIX settings files are written with mode `0600`.
CLI configuration output redacts fields whose names contain `key` or `token`.

Do not commit settings, provider keys, GitHub tokens, `.env` files, or MCP credentials. If a token appears in a document or Git history, revoke it immediately; replacing the text does not invalidate the credential.

Git remote URLs must not contain credentials. Use a credential manager, SSH agent,
GitHub CLI authentication, or repository/organization secrets for automation.

## Network requests

`web_fetch` permits HTTP and HTTPS, blocks well-known cloud metadata/link-local endpoints, limits response size, and uses timeouts. This reduces common SSRF impact but is not a complete network sandbox. External content is untrusted and may contain prompt injection.

MCP HTTP endpoints are user configuration. Use TLS and trusted servers.

## Dependency policy

Production dependencies should pass:

```bash
npm audit --omit=dev
```

Development-only advisories in packaging tools are evaluated separately because those tools do not ship in the renderer runtime. Do not use `npm audit fix --force` without validating build and API compatibility.

## Reporting

Do not open a public issue for an unpatched vulnerability. Use the repository's
**Security → Report a vulnerability** form. If private vulnerability reporting is not
available, open a public issue requesting a private contact channel without including
technical details.

Include:

- affected version and platform;
- reproduction steps;
- impact;
- suggested mitigation, if known.

Please allow time for triage and a coordinated fix before disclosure.
