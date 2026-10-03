# Changelog

## 0.11.0-alpha.22

- 增加 Ubuntu 24.04 x64 的 DEB/AppImage 构建、用户组件目录和首次使用准备界面。
- 接通 Linux Word/PDF、Tesseract OCR、PDF 图片渲染、LibreOffice 26.2 公式计算、Qwen/Paddle 视觉运行时及 X11 AT-SPI 桌面桥接。
- 增加可部署邮箱验证码账号服务、注册登录界面、会话撤销与注销；未配置邮件服务时允许继续使用本地功能。
- 跨平台拒绝插件绝对路径；处理 Linux 密钥库不可用、账号地址配置错误、模型子进程回收和浏览器异常退出。
- Windows 全量 441 通过/1 跳过；Linux 全量 434 通过/8 跳过，均为 442 项基线。最后新增账号配置容错后，账号与凭据专项两平台各 12/12 通过，不能与全量结果相加。
- 仅验证 Ubuntu x64/X11 基线；Wayland 截图与全局快捷键、真实邮件送达、全行业票据准确率和其他发行版仍未完整验收。部署及边界见 `docs/LINUX_SETUP.md`、`docs/ACCOUNT_SERVICE.md`。

## 0.11.0-alpha.21

- 内置行业数据与 Excel 公式技能：按资料确定实体、字段、单位和工作表，保留业务口径与来源证据。
- 支持显式公式、同工作簿跨表引用、SUMIFS、IFERROR、XLOOKUP、INDEX/MATCH 等常用函数；原文以等号开头仍按文本保存。
- 用本地 LibreOffice 实际重算，逐公式对比预期结果，保留可编辑公式与结果缓存；错误、不一致或仅写入未重算时不通过交付验收。
- 432 项软件与 13 项 Python 回归通过；真实行业识别准确率及任意 Excel 函数兼容性未作普遍保证。详见 `docs/PUBLIC_RELEASE.md`。

## 0.11.0-alpha.20

- 开头大标题后固定两个空白段落，章节标题与其余格式保持；新增只修正现有 Word 标题空行并另存副本的内置动作，保留图表。
- 默认采用每阶段预算，解除任务累计 160 轮/300 次工具调用锁定；原任务保留历史、计划和费用，累计限制改为显式选项。
- 工具预算边界保存检查点，正式 Word 清单与试制文件分别验收，统一相对/绝对路径重试证据。
- Word 提取补充表格坐标、合并信息和结构画像；Agent 按资料自行确定 Excel 字段、记录粒度和拆表，逐表设计依据留入审计。
- 425 项软件及 10 项 Python 回归通过；详细状态、检测数据与人工测试步骤见 `docs/PUBLIC_RELEASE.md`。

## 0.11.0-alpha.19

- 新增内置 Word 生成、Word 转 PDF、PDF 转可编辑文字稿及来源审计，默认直接保存当前项目。
- 固定应用用户提供的公文排版规则，检查字体缺失与格式声明；不将文本重建称为无损版式互转。
- 增加 Word 专用验收，区分软件测试与文档产物；阶段回执明确轮次边界和未完成状态。
- 修复 Windows 中文输出、Python heredoc 误用提示及后续打印掩盖原生命令失败的问题。
- 417 项回归通过；实际转换、字体限制与原测试故障诊断见 `docs/PUBLIC_RELEASE.md`。

## 0.11.0-alpha.18

- 内置 Qwen3.5-9B / PaddleOCR-VL-1.6 本地视觉工具，组件下载、固定哈希校验及进程管理。
- 桌面新增视觉组件面板与图片/PDF 导入；按项目隔离来源与识别证据。
- Paddle 全页识别证据可接入 Excel，保留页覆盖和待复核状态；局部看图不能冒充全量读取。
- 397 项回归通过；真实模型验证范围和已知限制见 `docs/PUBLIC_RELEASE.md`。

## 0.11.0-alpha.10

### Context compaction

- Summarises the span the context budget is about to remove instead of leaving
  only a "content omitted" marker. On a recorded 528-message task the model
  previously ended a turn seeing 21 messages — 96% of the conversation gone,
  with nothing but an instruction to re-read the files it had already read.
- Splits the replacement into two labelled halves: **facts** extracted
  deterministically from the dropped tool calls (files written, commands run,
  failure counts) and a model-written **recollection** of intent, findings and
  decisions. The block states which half is evidence, and the summariser is
  instructed to render any completion claim as "asserted, unverified".
- Applies inside the agent loop, so the terminal and the desktop app get it
  from the same code. Semantic compaction previously existed only in the
  terminal UI, which left desktop long tasks truncating without a summary.
- Summarises incrementally: a new summary carries the previous one, so repeated
  compactions stay connected rather than restarting each time.
- Re-summarises only after enough fresh material accumulates, and caches the
  result across turns — summarising every turn would cost more than it saves.
- Uses the provider already in use for the run. Records the summarisation calls
  as a cost; they are extra paid requests, not free.
- Degrades without failing: a summarisation error keeps the factual half and
  falls back to the plain marker rather than ending the task.
- The user's opening request is never summarised away.

### Model pricing

- Adds a price registry with cache-hit and cache-miss as separate rates. Cache
  reads are billed and dominate long runs by volume — one recorded session
  logged 58.7M cache reads against 2.2M uncached input, 27× more. Omitting the
  cache rate did not make those tokens free, it made every reported cost wrong.
  Recomputed over the full local record, cache reads are 64% of the bill.
- Stops falling back to Claude Sonnet's prices for unregistered models. An
  unknown model now reports an unknown cost, and the UI says so instead of
  printing `$0.000`. Three separate places hardcoded Anthropic rates regardless
  of the provider in use; all now read the registry.
- Every entry carries its source and effective date, and the DeepSeek cache
  rate is marked as promotional so a stale figure can be recognised later.
- Costs are currency-aware: DeepSeek bills CNY, Anthropic USD, and the two are
  no longer added together under a USD-named field.

### Fixed

- Waits for stopped services to exit before reclaiming them, so a caller that
  cleans up the workspace immediately afterwards no longer hits EBUSY on a
  directory the dying process still holds.

## 0.11.0-alpha.9

- Stops the context budget from shortening the canonical transcript. The model
  now receives a derived working context while the full record — the one that
  session export, resume, and memory extraction read — only ever grows.
  Trimming it was a token saving paid for with the user's own history.
- Deriving the working context fresh each turn also costs less than trimming in
  place: on a recorded 260-turn session the estimated resent input falls from
  8.78M to 3.99M, and peak per-turn context from 58,148 to 44,181.
- Retires provider thinking text once a newer assistant turn exists. It can
  never be replayed, so keeping it grew the record and stored hidden reasoning
  the durable transcript is not meant to hold.
- Adds durable task state derived from persisted events — goal, plan, modified
  files, tests run, unresolved errors — with the tool-call ids that prove each
  item. A step the model called done with nothing supporting it carries an
  empty evidence list rather than being promoted to fact.
- A resumed run starts from that verified state instead of re-reading the
  project, so the context saving does not turn into extra tool rounds.
- Adds a session schema version with an idempotent migration that never drops
  conversation content and leaves the original file untouched when it fails.
- Adds `npm run replay:context` and `npm run fixtures:build`: a no-network
  offline replay across `legacy`/`alpha8`/`candidate`, and redacted fixtures in
  three size classes. Every figure it emits is labelled an estimate, never a
  provider bill.
- Fixes a service falsely reporting ready when the health URL was answered by a
  different process already holding the port while the spawned process exited
  with EADDRINUSE.
- Corrects the published cost figures. The earlier "86.2% / 172×" mixed two
  estimators and excluded fixed per-turn overhead. Reproducible numbers, with
  overhead included: 4.7% on a short task, 5.9% on a medium one, 92.2% on the
  long one — the saving depends heavily on task length.

## 0.11.0-alpha.8

- Caps the transcript resent on every model turn. Because each turn rebills the
  whole working set, an unbounded history cost O(n²): replaying a real 528-message
  session measured 49.6M billed input tokens against 313K tokens of actual
  content — a 172× amplification.
- Stops resending every past turn's thinking text. DeepSeek needs it only for
  the turn being continued, and its own guidance is that earlier rounds must not
  be concatenated back; historical reasoning was 37% of that session's context.
- Applies the budget inside the agent loop so every front end benefits. Context
  management previously lived only in the terminal UI, which left the desktop
  app with no history limit at all — `maxHistoryMessages` and
  `compactionThreshold` silently did nothing there.
- Ages older tool results to a short excerpt instead of dropping them, so no
  tool call loses its result and no provider rejects the transcript.
- Preserves the original request and marks omitted history explicitly, telling
  the model to re-read rather than trust a faded memory.
- Adds `context.maxContextTokens` and `context.keepRecentMessages`, and records
  the tokens each run kept off the wire.
- Measured end to end on the same session: **86.2% fewer billed input tokens**
  (49.6M → 6.8M), peak per-turn context down 80%.

## 0.11.0-alpha.7

- Adds the delivery receipt: every finished task reconciles what the assistant
  declared in its plan against what the persisted tool evidence proves, and
  states the difference in language a non-engineer can act on. Assistant prose
  is never an input — a step counts as done only when a tool result of the right
  kind actually succeeded.
- Separates three verdicts a reader can act on: proven, contradicted by the
  run record, and honestly unverifiable. The second and third are the point:
  they are what a person who cannot inspect the work would otherwise never see.
- Requires every kind of proof a step implies rather than the first one matched,
  and no longer reads a script *name* such as `start:test` as evidence of
  testing — that misreading let an unrelated passing unit-test run certify a
  service that never started.
- Respects a step that honestly declares its own gap (for example "not
  compiled") as unverifiable rather than contradicted.
- Recovers the declared plan from the durable event log when a resumed run
  checkpoints without one, instead of silently losing the declaration and
  leaving nothing to reconcile.

## 0.11.0-alpha.6

- Adds `service_start` / `service_status` / `service_stop`: long-running dev and
  API servers now survive past the tool call that started them, with their
  output captured to a log file and readiness proven by a health URL. The shell
  tool could only run a server until its timeout and then killed the whole tree,
  so no frontend task could ever reach a verifiable state.
- Adds `browser_verify`: renders a page in an installed Chrome or Edge over the
  Chrome DevTools Protocol and reports HTTP status, title, rendered text,
  uncaught exceptions, console errors, failed requests, text assertions and an
  optional screenshot. No npm dependency and no browser download.
- Fixes silent loss of a background service's output on Windows, where
  `detached` gave the child a new console and its stdout bypassed the log file.
- Accepts `browser_verify` as real browser evidence in the completion gate, and
  reports a failed verification as a defect to repair instead of missing proof.
- Stops treating a bundler such as `vite` as proof of a user interface, so a
  backend-only project is no longer failed for lacking browser E2E.
- Accepts a health-checked service plus a real local request as API evidence
  when a project declares no integration script; previously such a project could
  never satisfy the gate.
- Raises the shell timeout ceiling to 15 minutes so dependency installs and cold
  builds are no longer killed mid-run.
- Waits for a stopped service to actually exit before returning, so restarting
  on the same port cannot race a dying process or read it as healthy.
- Waits for the headless browser to exit before deleting its temporary profile,
  and sweeps profiles orphaned by an earlier crash, instead of leaking a
  multi-megabyte directory per verification.
- Reclaims background services when a run ends, so a leftover process cannot
  hold a port into the next run.

## 0.11.0-alpha.5

- Recognizes `puppeteer-core` as a real browser E2E runner in the independent
  completion gate instead of falsely rejecting successful Chrome evidence.
- Accepts a successfully executed exact package-script body as evidence when
  the script alias was added after iterative debugging.
- Requires shell-statement boundaries for direct script evidence, preventing
  echoed or quoted browser commands from forging a successful E2E result.
- Re-evaluates the persisted Binary Market task successfully: engineering tests
  and real browser E2E both pass under the corrected deterministic gate.

## 0.11.0-alpha.4

- Guarantees that a Windows shell tool returns control at its declared timeout,
  even when detached descendants keep inherited stdio handles open.
- Recovers descendant process IDs from the Windows process snapshot when the
  original PowerShell launcher has already exited, then terminates the orphaned
  npm/Node tree without scanning or killing unrelated processes.
- Preserves partial command output in timeout diagnostics and reports a
  deterministic exit code 124 instead of leaving a task falsely running.
- Adds a regression that reproduces the real `Start-Process` + redirected
  npm/server hang observed during the Binary Market Protocol challenge.

## 0.11.0-alpha.3

- Terminates the complete PowerShell/npm/Node child-process tree when a native
  Windows command times out or the user pauses the task.
- Treats a signal-terminated process with an unknown exit code as an error
  instead of false success, and gives the model actionable hung-test guidance.
- Adds a critical live-monitor alert when a running tool has no result for more
  than 60 seconds.
- Routes exact novice phrases such as `请继续` and `请接续` to the selected
  resumable task instead of silently creating another durable task.
- Adds real Windows child-tree timeout and abort tests.

## 0.11.0-alpha.2

- Reclassifies the per-run model-turn limit as a durable, resumable checkpoint
  instead of a fatal `Agent loop exceeded` error.
- Adds final-eight-turn budget steering so long tasks synchronize their plan,
  close a runnable vertical slice, create missing startup assets, and verify
  before a run boundary.
- Preserves non-dangerous task-level permission allowances across pause/resume
  runs and makes the task-scoped choice the recommended desktop action.
- Clarifies that the legacy `bash` tool invokes PowerShell on an unsandboxed
  Windows host, reducing cmd/Bash syntax drift.
- Adds monitor classifications for run-budget boundaries and stale plans.
- Records the first Binary Market Protocol challenge honestly: the interrupted
  DeepSeek V4 Pro run scored 3/100 in the independent delivery evaluator even
  though its isolated domain suite passed 36/36 tests.

## 0.11.0-alpha.1

- Added a versioned Agent Engine contract and honest health gates for native,
  Codex CLI, and DeepSeek Harness adapters.
- Added plugin manifest validation and a desktop Agent Engine center.
- Replaced the repeated OmniTrade case with a Binary Market Protocol full-stack
  benchmark and project-external deterministic acceptance runner.
- Improved Kimi K3 model discovery/normalization and selected-model diagnostics.

## 0.10.0-alpha.10

- Canonicalizes known DeepSeek model IDs in both saved settings and wire requests,
  preventing case-sensitive 400 errors while preserving unknown custom IDs.
- Starts every normal prompt as a new durable task while retaining session memory;
  terminal task goals and monitoring evidence are no longer silently reused.
- Rejects disk/filesystem roots as autonomous workspaces.
- Replaces per-chunk text/thinking/progress persistence with compact stream
  summaries and excludes high-frequency telemetry from full-text indexing.
- Removes the monitor's 2,000-event truncation, counts actual Provider usage
  turns, calculates TTFT from the latest successful run, deduplicates terminal
  failure events, and applies workload-sensitive efficiency scoring.
- Adds configurable per-run/per-task model-turn and task tool-call budgets.
- Adds a deterministic completion gate. Code tasks cannot be marked complete
  when declared engineering checks, real browser E2E, or API integration
  evidence is missing. This is evidence enforcement, not a claim of semantic
  correctness or an international benchmark score.

## 0.10.0-alpha.9

- Added DeepSeek V4 Pro reasoning/tool-state continuation, OpenAI Responses
  transport, dynamic model discovery, capability diagnostics, and honest local
  model tiers.
- Added a desktop Skill manager and experimental MCP connector manager with
  explicit connection/tool discovery tests.
- Added durable `plan_update` working state and a visible task plan in the
  execution panel, inspired by public context-engineering patterns rather than
  proprietary implementation details.
- Added provider benchmarks for tool round trips, false-execution detection,
  latency, tokens, and reported cache usage. No credential means no score.
- Added a local real-time Agent monitor with persisted event timelines,
  deterministic drift/error alerts, evidence-scoped scoring, and user-initiated
  redacted JSON export. It does not upload telemetry or capture hidden reasoning.
- Corrected earlier competitive language: Alpha.9 is an engineering Alpha, not
  a proven replacement for Codex, Claude Code, Manus, Doubao, or WorkBuddy.

All notable changes to AllyCode are documented here. The project follows semantic
versioning where practical; alpha releases may still contain breaking changes.

## [Unreleased]

- No changes yet.

## [0.10.0-alpha.9] - 2026-08-13

### Added

- DeepSeek V4 Pro/Flash capability registry, thinking controls, 1M context and 384K output metadata.
- OpenAI Responses API streaming transport with stateless encrypted reasoning-item continuation.
- Live provider model discovery with explicit live/fallback and verified/unverified labels.
- Five-stage provider diagnostics, including mandatory tool-result second-turn verification.
- Local-model two-turn native-tool probe and L1/L2/L3 Agent capability tiers.
- Reproducible paid-provider benchmark for chat, tools, continuation, false-execution claims, latency, usage and cache telemetry.

### Changed

- Fresh installs now default to `deepseek-v4-pro`.
- OpenAI automatic protocol selection now uses Responses; DeepSeek direct API uses Chat Completions.
- Tool-call and tool-result history is checkpointed atomically to avoid orphan recovery failures.
- Provider-specific continuation state is persisted in canonical sessions/checkpoints and stripped from unrelated transports.

### Fixed

- DeepSeek thinking-mode tool rounds now return the preceding `reasoning_content` exactly as required.
- Local model names no longer self-certify native tool support.
- Local context length is no longer mistaken for the provider maximum output-token limit.
- DeepSeek automatic cache-hit counters are normalized into AllyCode usage telemetry.

### Verification boundary

- Offline protocol and runtime tests do not claim real-model quality scores.
- Live benchmark results require maintainer/user API credentials and are never fabricated when credentials, network access, or compatible models are unavailable.

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

[Unreleased]: https://github.com/jiayu6954-sudo/allycode/compare/v0.10.0-alpha.9...HEAD
[0.10.0-alpha.9]: https://github.com/jiayu6954-sudo/allycode/compare/v0.10.0-alpha.8...v0.10.0-alpha.9
[0.10.0-alpha.8]: https://github.com/jiayu6954-sudo/allycode/releases/tag/v0.10.0-alpha.8
