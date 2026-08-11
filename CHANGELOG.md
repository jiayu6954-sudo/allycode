# Changelog

All notable changes to AllyCode are documented here. The project follows semantic
versioning where practical; alpha releases may still contain breaking changes.

## [Unreleased]

- No changes yet.

## [0.10.0-alpha.8] - 2026-08-11

### Added

- Windows DPAPI-backed desktop credential vault with plaintext migration.
- Chinese first-run setup for DeepSeek, Alibaba Qwen, and Moonshot/Kimi.
- DeepSeek and `deepseek-chat` as domestic-friendly defaults.
- NSIS update state, manual download flow, and primary/mirror HTTPS fallback.
- Production release preflight, mandatory Windows signing, signature verification,
  and SHA-256 release manifests.
- Durable desktop tasks, pause/resume checkpoints, project event search, session
  export/deletion, and visible execution timing.

### Security

- Stored desktop credentials no longer cross the renderer IPC boundary.
- Production dependency audit updated with a patched `js-yaml` override.
- Formal release builds fail when signing or update-origin configuration is missing.

### Known limitations

- The project remains alpha software.
- Windows is the currently packaged desktop target.
- Signed public installers and live update infrastructure require maintainer-owned
  certificate and hosting credentials.

[Unreleased]: https://github.com/jiayu6954-sudo/allycode/compare/v0.10.0-alpha.8...HEAD
[0.10.0-alpha.8]: https://github.com/jiayu6954-sudo/allycode/releases/tag/v0.10.0-alpha.8
