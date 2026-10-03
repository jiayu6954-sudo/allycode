# Contributing to AllyCode

Thank you for helping improve AllyCode. This project welcomes focused bug fixes,
tests, documentation, provider compatibility work, and security improvements.

## Before opening a change

- Search existing issues and pull requests.
- For larger features, open an issue first and describe the user problem, security
  impact, and proposed scope.
- Never include API keys, tokens, private logs, local project contents, or generated
  runtime data.
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Development setup

Requirements:

- Node.js 22.13 or newer;
- npm 10 or newer;
- Windows, macOS, or Linux for CLI development;
- Windows for Windows installers; Ubuntu 24.04 x64 for the tested Linux desktop baseline;
- Docker only for optional sandbox testing.

```bash
git clone https://github.com/jiayu6954-sudo/allycode.git
cd allycode
npm ci
npm run typecheck
npm run typecheck:desktop
npm run lint
npm run test:run
npm run build
```

Run the terminal application:

```bash
npm run dev
```

Run the desktop application:

```bash
npm run desktop
```

## Office regression prerequisites

The full suite includes real document and formula checks. Install Python 3.10+ and the dependencies in `skill/sources-to-excel-complete/sources-to-excel/linux-requirements.txt` (use a virtual environment on Linux). Linux also requires the system packages installed by `scripts/linux-components.sh` inside that skill directory; review the fixed package list before running it with sudo. Then run:

```sh
npx tsx scripts/setup-formula-tests.ts
```

This installs optional document components and may download a large LibreOffice runtime. `ALLYCODE_DOCUMENT_HOME` can point to an existing prepared component directory. It does not call a paid model. Test fixtures contain synthetic or character-class-redacted data.

## Pull request expectations

- Keep changes scoped and explain why they are necessary.
- Add regression tests for behavior changes and bug fixes.
- Preserve the provider-neutral agent and tool interfaces unless the migration is
  part of the proposal.
- Validate untrusted input with Zod or an equivalent explicit boundary.
- Keep Electron renderer access behind the typed preload API.
- Do not weaken workspace containment, permission checks, secret redaction, or
  sandbox fail-closed behavior.
- Update public documentation when commands, configuration, or user-visible behavior
  changes.

Before submitting, run:

```bash
npm run typecheck
npm run typecheck:desktop
npm run lint
npm run test:run
npm run build
npm audit --omit=dev
```

## Commit and PR style

Use a concise imperative title, for example:

```text
Fix provider timeout propagation
Add regression coverage for session deletion
Document Windows credential migration
```

A pull request should include:

- the problem and affected user flow;
- the implemented approach;
- security or compatibility impact;
- tests performed;
- screenshots for visible desktop changes.

## License

By contributing, you agree that your contribution is licensed under the project's
[MIT License](LICENSE).
