---
name: Bug report
about: Something is broken or behaving unexpectedly
title: "[BUG] "
labels: bug
assignees: ''
---

## Describe the bug

A clear and concise description of what is broken.

## Steps to reproduce

1. Run `allycode ...` or open the desktop application
2. Enter prompt: `...`
3. See error

## Expected behavior

What you expected to happen.

## Actual behavior

What actually happened. Paste the exact error message or unexpected output.

## Debug log

Attach only the relevant, sanitized section of `~/.allycode/debug.log` (or `$ALLYCODE_DATA_DIR/debug.log`):

```
allycode --verbose "your prompt"
```

<details>
<summary>debug.log excerpt</summary>

```
paste log here
```

</details>

## Environment

| Field | Value |
|-------|-------|
| AllyCode version | `allycode --version` output or desktop version |
| Node.js version | `node --version` |
| OS | Windows 11 / macOS / Linux |
| Provider | anthropic / deepseek / ollama / ... |
| Model | e.g. claude-sonnet-4-6 |
| Ollama version (if applicable) | `ollama --version` |

## Config (sanitize API keys)

```bash
allycode config show --json
```

```json
paste output here (remove API keys, tokens, project paths, and private data)
```

## Additional context

Any other context — terminal type, Docker availability, network environment, etc.
