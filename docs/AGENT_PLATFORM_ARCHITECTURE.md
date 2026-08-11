# AllyCode Agent Platform Architecture

## Product boundary

AllyCode is a local-first Agent platform, not a thin model chat client. A task is
complete only when it produces a verified change, an artifact, or an evidence-backed
report. Model APIs are interchangeable reasoning engines behind the task runtime.

## Runtime layers

1. **Desktop experience** — projects, tasks, conversations, plans, execution evidence,
   memory, diffs, artifacts, permissions, and settings.
2. **Task runtime** — durable task state, event journal, checkpoints, pause/resume,
   retries, token budgets, completion conditions, and failure recovery.
3. **Agent loop** — provider-neutral streaming, tool selection, parallel safe tool
   execution, context management, and result verification.
4. **Capability layer** — local files, shell, Git, web, research, MCP, skills, session
   search, browser automation, delegation, scheduling, and artifact delivery.
5. **Execution backends** — trusted host, persistent Docker/WSL, SSH, and future
   microVM/cloud workers behind one interface.
6. **Memory system** — active context, task checkpoints, full event history, project
   knowledge, user preferences, semantic retrieval, and procedural skills.
7. **Security and governance** — project path boundary, risk classification, explicit
   network/write approval, sandbox policy, audit trail, secret redaction, and rollback.

## Durable task model

The SQLite database at `~/.allycode/agent-state.sqlite` uses WAL mode and contains:

- `projects`: stable logical project identities and the most recently opened path.
- `project_paths`: path aliases, so a logical project can survive directory changes.
- `tasks`: goal, session binding, status, checkpoint, failure, and revision metadata.
- `task_events`: append-only execution evidence for messages, tools, permissions,
  checkpoints, memory extraction, completion, and failure.
- `task_event_search`: FTS5 index with a literal fallback for Chinese text.

Active tasks left by a process crash are changed to `paused` on the next launch. They
are never silently restarted. The user can inspect and resume them from the desktop.

## Checkpoint contract

- Persist the user goal before the first model request.
- Persist canonical provider history after each completed model/tool iteration.
- Persist permission requests and decisions before execution continues.
- A pause aborts the active atomic operation, saves the last consistent history, and
  leaves the task resumable.
- Resume injects a continuation instruction into the saved canonical history. It does
  not reconstruct state from a lossy UI transcript.
- Completion saves usage, session history, a final checkpoint, and then extracts
  durable memory.

## Memory contract

- **Working memory:** bounded current context and compaction summary.
- **Task memory:** exact checkpoint, execution journal, failures, and permission state.
- **Episodic memory:** searchable prior task events for the same project.
- **Project memory:** architecture, constraints, decisions, and proven solutions.
- **User memory:** stable preferences and working style, shared only where intended.
- **Procedural memory:** on-demand skills for repeatable workflows.

The system persists actions and decisions, not hidden model chain-of-thought. Recalled
information is treated as evidence and is verified against the current workspace.

## Domestic and private-network operation

- First-class DeepSeek, Alibaba Qwen/DashScope, Moonshot/Kimi, local Ollama, and custom
  OpenAI-compatible endpoints.
- Self-hosted SearXNG can be placed inside a domestic network or enterprise intranet.
- Search falls back through configured providers instead of assuming one public
  service is reachable.
- Semantic memory falls back to local TF-IDF when Ollama embeddings are unavailable.
- Core file, task, memory, and sandbox workflows do not require an overseas service.

## Sandbox policy

Docker is one backend, not the entire architecture. Persistent task containers retain
dependencies and workspace state across commands. The default hardened profile uses a
non-root user, drops all Linux capabilities, enables `no-new-privileges`, applies CPU,
memory and PID limits, uses a read-only container root, and mounts only the selected
workspace. Strict mode also makes that workspace read-only and disables networking.

If Docker is enabled but unavailable, AllyCode fails closed. Host fallback requires an
explicit configuration choice. Future multi-tenant execution must use a stronger
microVM or equivalent isolation boundary.

## Planned platform increments

1. Structured plan/todo state and completion criteria in the durable task engine.
2. File snapshots, diff review, checkpoints, and one-click rollback.
3. Browser automation, background processes, artifact registry, and downloads.
4. General subagent delegation with isolated context and restricted capabilities.
5. Schedules, retries, notification delivery, and unattended trusted workflows.
6. Evaluation suites for coding, research, recovery, memory, and malicious projects.
