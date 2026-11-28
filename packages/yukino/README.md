# Yukino

Yukino is a terminal-based AI coding agent. It provides an interactive UI (terminal user interface) for conversing with large language models, executing code, manipulating files, and orchestrating multi-agent workflows, all from the command line.

## Overview

Yukino runs as a single CLI binary that connects to configurable LLM providers (Anthropic, OpenAI, or any OpenAI-compatible endpoint). It renders a rich terminal interface using React and Ink, giving you streaming responses, tool execution feedback, permission prompts, and slash commands in a single pane.

Beyond interactive use, Yukino supports a non-interactive print mode for scripting, a remote mode that serves a browser-based chat UI over WebSocket, an A2A (Agent2Agent) server mode for agent-to-agent integration, and team coordination where one leader agent manages multiple teammates running in the same process and working in parallel.

## Features

### Core Capabilities

- Multi-provider LLM support with Anthropic (Anthropic Messages), OpenAI (OpenAI Responses), and OpenAI-compatible (OpenAI Chat Completions) protocols
- Interactive terminal UI with streaming text, thinking indicators, and tool execution display
- Built-in tool set: ReadFile, WriteFile, EditFile, Bash, PowerShell, Glob, Grep, WebFetch, ComputerUse, ToolSearch, McpCall, EnterWorktree, ExitWorktree, ExitPlanMode, Goal, the TodoWrite tracking tool, plus Workflow, Agent, LoadSkill, InstallSkill, AskUserQuestion, SyntheticOutput, TeamCreate, SendMessage, TeamDelete, TaskOutput, and TaskStop
- MCP (Model Context Protocol) server integration for extending the tool set with external services
- Permission system with four modes: default, acceptEdits, plan (read-only), and bypassPermissions
- Sandbox support through [Anthropic Sandbox Runtime](https://github.com/anthropics/sandbox-runtime) (bubblewrap on Linux, Seatbelt on macOS)
- Human-in-the-loop approval dialogs for file writes and shell commands, driven by permission mode and allow/deny rules
- Tool completion events stream as calls finish; conversation history and session logs retain the original call order
- Asynchronous text reads and batched file edits with overlap validation and preserved line endings
- Home-relative tool paths (`~` and `~/...`) resolve consistently in file tools, search, and permission checks
- Grep uses the bundled [`@vscode/ripgrep`](https://github.com/microsoft/vscode-ripgrep) binary and its Unicode-aware default regex engine. File admission and directory pruning happen before content search; ripgrep receives only approved files and cannot recurse. Patterns with unsupported lookaround or backreferences return native syntax errors.
- Grep and Glob bound their result bodies to 50 KiB and honor cancellation; Grep shortens long matching lines at UTF-8 boundaries and explains how to read the full text
- Image reads detect the actual format, including files without an image extension
- Transient provider failures use bounded, interruptible retries before visible output; incomplete responses cannot execute pending tools

`EditFile` accepts `file_path` and a non-empty `edits` array. Each entry contains `old_string`, `new_string`, and optional `replace_all`. All entries match the original file, and validation completes before the file is written once. Use one call for disjoint changes in the same file:

```json
{
  "file_path": "src/example.ts",
  "edits": [
    { "old_string": "const first = 1;", "new_string": "const first = 2;" },
    { "old_string": "const second = 3;", "new_string": "const second = 4;" }
  ]
}
```

### Conversation and Memory

- Session persistence with JSONL-based storage for cross-session resume
- Session-local persistent goals with automatic continuation, explicit pause/resume, token budgets, and completion/blocker audits
- Automatic context compaction when conversations approach the model's context window
- Long-term memory extraction and recall across sessions (disable with `enable_memory: false` in `~/.yukino/config.yaml`)
- Instructions files for persistent guidance: user-global `~/.yukino/AGENTS.md`, plus `AGENTS.md` in every directory from the git root down to the working directory; instruction files are read literally

### Skills and Commands

- Skill catalog loading from `~/.agents/skills/`, `~/.yukino/skills/`, and project `.agents/skills/`, in increasing priority
- Hot-reload support for skills edited on disk
- Recursive discovery of grouped skills, with cycle protection and discovery stopping at each declared skill root
- Inline and fork execution modes for skills
- Slash command system with built-in commands and global prompt templates from `~/.yukino/prompts/`
- Skill installation from a local path or a raw SKILL.md URL

Command templates support quoted positional arguments (`$1`, `$2`, ...), `$@`, defaults such as `${1:-main}`, and slices such as `${@:2:3}`. `$ARGUMENTS` and `$@` join parsed arguments with spaces, matching Pi template expansion. Substitution runs once, so placeholder text inside an argument stays literal. A template without a placeholder appends the original arguments.

### Agent Orchestration

- Subagent spawning with built-in agent types: general-purpose, plan (read-only architect), explore (read-only code explorer)
- Team coordination with file-based mailboxes and leader/member communication
- Coordinator mode for managing multi-agent workflows
- Git worktree isolation for parallel agent tasks

### Hooks

- Event-driven hook engine supporting: session_start, session_end, turn_start, turn_end, pre_send, post_receive, pre_tool_use, post_tool_use, shutdown
- Hook actions: shell commands, HTTP requests, and prompt injection (`agent` actions fail application configuration validation)
- Conditional execution, one-shot (`once`) hooks, `reject` (blocks a tool call on pre_tool_use), `on_error` handling (ignore, fail, reject), and fire-and-forget `async` execution (`reject` and `async` are mutually exclusive)

### Remote Mode

- Express HTTP server with WebSocket bridge for browser-based access
- React frontend served at a configurable address
- Bidirectional message streaming between browser and agent

## Installation

```bash
npm install -g @yukino.js/yukino
```

Or use the one-line installers ([macOS / Linux](../../install.sh), [Windows](../../install.ps1)):

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/hangtiancheng/yukino-code/main/install.sh | bash
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/hangtiancheng/yukino-code/main/install.ps1 | iex
```

Both installers write a default `~/.yukino/config.yaml` if none exists, verify Node.js 22.19+ (23.x requires 23.5+), and support uninstall / pinned-version / dist-tag options (see their `--help` / `-h` output).

Update a global npm, yarn, or pnpm installation with:

```bash
yukino update
yukino update --tag=canary
yukino --version
```

The command checks npm's `latest` dist-tag by default. Use `--tag=canary` (or `--tag canary`) to check another dist-tag. If its version is newer according to SemVer, the command installs that exact version using the package manager that provides the current installation. For example, `0.0.10-canary` is newer than `0.0.8-dev`. Equal or older versions are not installed. Both one-line installers use npm, so their installations support `yukino update` too. Source checkouts must be updated from the repository.

The TUI always checks npm's `latest` dist-tag for a newer release asynchronously and shows a `yukino update` hint on entry when one is available. The hint disappears after the first input submission or when a session is resumed; late check results stay hidden during the conversation. Available updates are shown again on the last line of the exit summary. Network errors do not interrupt the UI. Explicit `yukino update` also checks for updates.

Or run directly from the monorepo:

```bash
pnpm dev
```

## Storage

Yukino stores its configuration and runtime state under `~/.yukino`. The current directory (`cwd`) determines where tools execute and which project `/resume` opens. It does not determine the storage root. Directories are created when their features are used. On POSIX, Yukino state directories use `0700` and state files use `0600`, including existing files reopened for reading or appending and temporary files used for atomic replacement. This policy covers runtime state, configuration and memory; it does not chmod working-tree source files. State writes reject symbolic links. These mode bits do not establish a Windows ACL policy.

```yaml
~/.yukino/                                 # Per-user storage root for global configuration, reusable definitions, project/session state and diagnostics.
├── config.yaml                            # Provider endpoints, credentials and models; default provider, permission mode, hooks, MCP and runtime settings.
├── AGENTS.md                              # Global Markdown instructions and coding/workflow rules supplied to sessions in every project.
├── permissions.yaml                       # User-wide Tool(pattern) permission rules and their effects, evaluated alongside project-specific rules.
├── activity.jsonl                         # Input events with IDs, timestamps, cwd, session, source, text and command names; project registry and usage checkpoints.
├── prompts/                               # Global reusable slash-command templates; nested directories provide command namespaces.
│   └── <command>.md                       # Markdown prompt body and optional YAML metadata; its relative path determines the slash-command name.
├── agents/                                # User-defined agent profiles that add agents or override built-in agent definitions by name.
│   └── <agent>.md                         # YAML model/tool/permission/turn-limit settings plus Markdown task instructions and optional system-prompt override.
├── skills/                                # Yukino-specific global skill catalog, including skills installed through InstallSkill.
│   └── <skill>/                           # One reusable skill package, with its entrypoint and any accompanying scripts, references or assets.
│       └── SKILL.md                       # Skill name, description and execution metadata in YAML frontmatter, followed by Markdown workflow instructions.
├── memory/                                # User-scoped long-term memory shared across projects, including preferences and feedback about assistant behavior.
│   ├── MEMORY.md                          # Global memory entrypoint containing concise topic links and summaries for inclusion in model context.
│   └── <memory>.md                        # Individual user/feedback memory: YAML name, description and type, followed by detailed Markdown content.
├── projects/                              # Project-scoped permission and memory state, isolated by canonical working-directory identity.
│   └── <project-key>/                     # One project namespace; the key is the SHA-256 hash of its canonical absolute cwd.
│       ├── permissions.yaml               # Project Tool(pattern) rules, including persisted allow-always approvals for tool operations.
│       └── memory/                        # Long-term knowledge about this project, such as architecture, conventions, decisions and reference material.
│           ├── MEMORY.md                  # Project memory entrypoint with concise links to project topics and shared global memories.
│           └── <memory>.md                # Project/reference memory with YAML name, description and type plus detailed Markdown facts or guidance.
├── sessions/                              # Conversation transcripts grouped by project, plus a separate namespace for session-owned artifacts.
│   ├── <project-key>/                     # Transcript namespace for one canonical cwd, used by project-local resume and global session enumeration.
│   │   └── <session-id>.jsonl             # Messages, user-input provenance, tool calls/results, thinking blocks, user Bash records, compaction boundaries and goal state.
│   └── artifacts/                         # Session-owned supporting data, keyed by session ID independently of the executing agent's current directory.
│       └── <session-id>/                  # One session's private task list, file-rewind data, clipboard images and persisted tool/shell output.
│           ├── tasks.json                 # Private task list with subjects, descriptions, status, owners, dependencies, metadata, priorities and nextId counter.
│           ├── file-history/              # File-rewind checkpoints and original file bytes, together with clipboard image attachments for this session.
│           │   ├── snapshots.json         # Tracked paths, checkpoint metadata, transcript line positions, baseline states, backup paths and backup sequence counter.
│           │   ├── <file-backup>          # Original file bytes for first-tracked baselines and per-checkpoint versions used to restore workspace files.
│           │   └── <clipboard-image>.png  # Clipboard image bytes; prompt @ references load these PNGs as image attachments in user messages.
│           └── tool-results/              # Full tool responses and shell capture files that remain accessible beyond shortened context/UI previews.
│               ├── <tool-call-id>.txt     # Full text of a spilled tool result, addressed by the encoded tool-call ID and referenced from shortened results.
│               └── shell-<random>.output  # Captured shell stdout/stderr, including complete command output beyond the in-memory preview.
├── cost/                                  # Local execution ledgers grouped by canonical project identity.
│   └── <canonicalprojecthash>/           # SHA-256 of canonical absolute cwd, identical to the project key.
│       └── <sessionhash>.jsonl           # SHA-256 of session ID; model attempts, observed usage and explicit price snapshots.
├── plans/                                 # Markdown plan documents shared through explicit per-session plan-file references.
│   └── <slug>.md                          # One plan's Markdown content, used by plan-mode editing, user approval and subsequent plan execution.
├── logs/                                  # Main-process structured diagnostics, grouped by the logging runtime's session ID.
│   └── <session-id>.jsonl                 # Pino warn/error/fatal events with timestamps, session/mode/module context and structured error details.
├── crash.log                              # Timestamped process starts/exits, terminal disconnections and crash stack traces for post-mortem diagnosis.
├── teams/                                 # Persistent team coordination state, isolated by project and team identity.
│   └── <project-key>/                     # Teams belonging to one canonical cwd; prevents unrelated projects from sharing rosters, tasks or mailboxes.
│       └── <team>/                        # One sanitized team-name namespace containing its roster, shared task board, mailboxes and teammate diagnostics.
│           ├── config.json                # Team metadata, leader ID, permission mode and member IDs/types/models/activity flags/worktree paths.
│           ├── tasks.json                 # Team-wide task board with creators, owners, statuses, dependencies, task metadata and nextId counter.
│           ├── inboxes/                   # Recipient-specific persistent mailboxes for communication between the leader and teammates.
│           │   └── <member>.json          # Message array with sender, text, timestamp, read state and optional protocol type/request ID/approval response.
│           └── logs/                      # Structured diagnostics from teammate processes, separated from main-process logs.
│               └── <session-id>.jsonl     # One teammate runtime's warn/error/fatal events, with session/mode/module context and error details.
└── worktrees/                             # Git worktrees used to isolate agent changes from the original checkout.
    └── <repository-key>/                  # Repository namespace keyed by the canonical Git repository root; shared across its subdirectories.
        └── <slug>/                        # Named worktree location for an EnterWorktree invocation or a worktree-enabled agent.
            └── <Git working tree>         # Checked-out source files on the worktree branch, the .git link file and copied project .agents resources.
```

### Global resources

`config.yaml` contains provider and application settings. `AGENTS.md` supplies global instructions. `permissions.yaml` supplies global permission rules; project rules are stored separately under `projects/`.

`prompts/` contains user slash-command templates, `agents/` contains agent definitions that can override built-in definitions, and `skills/` contains skills installed by `InstallSkill`. Skill discovery also reads standard `~/.agents/skills/` and project `.agents/skills/`, in this order: global standard skills, global Yukino skills, then project standard skills. Later entries override earlier names. Project `AGENTS.md` and `.mcp.json` remain ordinary project resources.

`activity.jsonl` records user input, canonical project directories, and resolved command names across CLI, WebSocket and print mode. It preserves separate events for identical submissions; input recall merges consecutive duplicate texts and retains the latest 10,000 events. Periodic atomic checkpoints retain cumulative command usage and all registered projects while bounding input history. Writes and checkpoint replacement share a cross-process lock. `memory/` stores user memories shared across projects, while `plans/` stores plan documents; each live session tracks its active plan path. `logs/` contains main-process logs and `crash.log` records process exits and failures.

### Project namespaces and resume

A project key is the lowercase hexadecimal SHA-256 of the canonical absolute `cwd`. Canonicalization resolves symlinks, so aliases of the same directory share a namespace. Distinct directories, including subdirectories and worktree directories, have distinct namespaces. Renaming or moving a project changes its key. Legacy project data is retained in place, not automatically migrated or deleted.

`sessions/<project-key>/` contains conversation JSONL files, compaction records, and goal state. `/resume` lists sessions only from the current directory's namespace. `projects/<project-key>/memory/` stores project memories, and `projects/<project-key>/permissions.yaml` stores remembered project permission rules. Teams use the same directory-based project key under `teams/`.

For example, starting Yukino in `/workspace/repo/app` and in `/workspace/other` produces different session lists and project memories, while both use the same input history and global prompt templates.

### Session artifacts and teams

`sessions/artifacts/<session-id>/` groups data owned by one session. `tasks.json` stores the private task list and its next-ID counter. `file-history/` stores rewind snapshots, original file backups, and clipboard images. `tool-results/` stores complete tool output and shell capture files. Session IDs are generated independently of the current directory, so artifacts keep their path when the executing agent switches directories.

Sessions and branch-referenced artifacts are not deleted automatically by an inactivity deadline. Archive and clean up sessions deliberately; reads do not refresh their user activity timestamps. Logs older than 30 days are cleaned separately. Shell output falls back to an operating-system temporary file if session storage is unavailable.

Each `teams/<project-key>/<team>/` contains team membership and process metadata in `config.json`, the shared task board in `tasks.json`, one JSON mailbox per member in `inboxes/`, and teammate logs in `logs/`. The private session task list and the team task board use separate files.

Both task files use `{ nextId, tasks }`. `nextId` is the positive integer allocated to the next new task; task IDs are positive decimal strings such as `"1"`. Deleting tasks preserves the counter, so later tasks do not reuse deleted IDs. TodoWrite reads and edits the complete task model, including structured `metadata`. Metadata edits merge top-level keys, with `null` deleting a key and nested values replaced as a whole; omitted fields retain their values.

### Git worktrees

Every Yukino-created worktree is stored at `~/.yukino/worktrees/<repository-key>/<slug>/`. The repository key uses the same SHA-256 algorithm as project keys, applied to the canonical Git repository root rather than the caller's subdirectory. Calls from different subdirectories of the same repository therefore place worktrees together. Different repositories have separate directories even when they use the same slug.

For example, a worktree named `fix-login` created from `/workspace/repo/app` is placed in `~/.yukino/worktrees/<SHA-256 of /workspace/repo>/fix-login/`, with branch `worktree/fix-login/work`. Yukino returns the absolute worktree path to the caller. Git's own worktree metadata remains in the repository's Git directory; `git worktree list` shows the registered paths.

Global configuration, prompts, agent definitions, and installed skills are shared directly with the worktree. Standard project `.agents` resources are copied into it. No project `.yukino` settings are copied. `EnterWorktree` accepts an optional `slug` (randomly generated when omitted) and switches the agent's working directory into the worktree. `ExitWorktree` operates on that agent's active session with `{ action: "keep" | "remove", discard_changes?: boolean }` and restores the original working directory. `keep` preserves the directory and branch; `remove` deletes both, using the runtime's recorded repository, branch, Git identity and initial HEAD. Removal refuses changed files, new commits, or unverifiable state unless the user confirms discarding work and `discard_changes` is true. With no active session, exit is a no-op. Existing trees from another runtime are never adopted. Project identity for resume, memory, and permissions stays anchored to the original project; starting a separate session directly in a worktree uses that directory's own project namespace.

Project `.yukino/workflows/` contains named workflow scripts. Configuration and runtime state use the global storage paths above.

Session lists order by the last persisted real user input on the active tree path, excluding tool results and internal reminders. Read-only transcript loads do not refresh modification time, and resume does not renew an expiry deadline: sessions are not automatically deleted for inactivity. Branch navigation changes the active path and its ordering time without deleting the departed branch. `/rewind` file restoration is a separate confirmed action, not destructive transcript truncation. `Session.listAllSessions()` returns globally ordered sessions with their canonical `cwd` and `projectKey`, using the activity log project registry. Projects without recoverable directory metadata are discovered when their known cwd is registered; older messages without user-input provenance have no last-user-message time.

## Configuration

Yukino reads a single global YAML configuration file:

- ~/.yukino/config.yaml

Both installers create the following minimal starter only when `~/.yukino/config.yaml` does not already exist; existing configuration and credentials are preserved. The starter uses `permission_mode: default`, has no providers, MCP servers or hooks, and explicitly disables automatic memory, coordinator mode and CodeMode. It does not start external MCP processes, connect to MCP endpoints or run command hooks.

```yaml
permission_mode: default
providers: []
default_provider: 0
enable_memory: false
enable_coordinator_mode: false
code_mode:
  mode: off
  inline_budget: 12000
mcp_servers: []
hooks: []
sandbox:
  enabled: false
  auto_allow: false
  network_enabled: true
```

With no provider, the TUI opens the provider login form. Print, RPC, remote and A2A modes require an explicitly configured provider. All modes start with `default_provider`, falling back to the first entry when that index is out of range. Print has no implicit permission bypass: non-interactive operations requiring approval fail without explicit preauthorization. The disabled OS sandbox is not isolation; `network_enabled: true` does not itself initiate network access.

The following is an opt-in configuration reference, not the installer template. Configure a provider through `/login` or put your own API key in your private configuration. The empty `api_key` fields below are deliberately not usable credentials and must be filled privately before making authenticated requests; omit the field instead if you explicitly want the matching host environment fallback. Do not commit credentials.

```yaml
# Initial permission mode. Enum: default | acceptEdits | plan | bypassPermissions.
# default asks for writes/commands unless policy preauthorizes them; acceptEdits allows
# edits; plan is read-only; bypassPermissions still honors explicit restrictions.
# Invalid values fail validation. Shift+Tab cycles default, acceptEdits, bypassPermissions.
permission_mode: default

# Explicit provider examples. The starter has providers: []; non-TUI modes need a provider.
providers:
  - name: ds-anthropic # Display name
    # Wire protocol. Enum: anthropic | openai | openai-compat. Also selects the API key
    # environment fallback: anthropic → ANTHROPIC_API_KEY, openai / openai-compat → OPENAI_API_KEY.
    protocol: anthropic
    # API endpoint. The provider identity — duplicate base_url across providers is rejected.
    base_url: https://api.deepseek.com/anthropic
    model: deepseek-flash # Model identifier
    api_key: "" # Set privately to your own API key; empty does not use environment fallback
    # Thinking level. Enum: off | minimal | low | medium | high | xhigh | max. Default: high.
    thinking: high
    context_window: 1000000 # Context window in tokens. Default: 1000000
    # Output token ceiling. Default: 128000; clamped to context_window; the thinking
    # budget shares this ceiling instead of raising it.
    max_output_tokens: 128000
  # Second provider, same fields as above, demonstrating the openai-compat protocol.
  - name: ds-openai
    protocol: openai-compat
    base_url: https://api.deepseek.com
    model: deepseek-flash
    api_key: "" # Set privately to your own API key, or omit for environment fallback
    thinking: high
    context_window: 1000000
    max_output_tokens: 128000

# 0-based index of the provider selected at startup. Default: 0.
default_provider: 0

# Automatic memory master switch. The starter explicitly sets false; when omitted, true.
# false turns off index injection, recall, background extraction and consolidation.
enable_memory: false

# Coordinator mode. Default: false. true narrows the leader's toolset to pure orchestration
# (team/task management) so all actual work is delegated to teammates.
enable_coordinator_mode: false

# Tool presentation: off (direct), on (direct + CodeMode), only (script first).
# Script-excluded control tools remain direct in only mode. Authorization is unchanged.
code_mode:
  mode: off
  inline_budget: 12000 # characters of inline tool declarations; 0 uses discovery only

# Live runtime and terminal preferences; also available in /settings.
auto_compaction: true
auto_retry: true
steering_mode: all # all | one-at-a-time
follow_up_mode: one-at-a-time # all | one-at-a-time
display:
  show_thinking: true
  expanded_tools: false
  editor_padding: 1 # 0..3 columns on each side
  output_padding: 1 # 0..3 columns on each side
  autocomplete_max_visible: 8 # 3..20 rows, bounded by terminal height

# Shared by the model Bash tool and user !/!! commands. Use a Bash-compatible shell.
# shellPath: /opt/custom/bash # executable path (spaces supported), or a command on PATH
# shellCommandPrefix: |
#   source ~/.bash_aliases

# MCP exposure uses per-server exposure and ordered tool_exposure rules, not mcp_loading.
# Provider wire adaptation does not change the selected exposure policy.

# Terminal theme: auto | dark | light. Default: auto, detected from terminal colors,
# then terminal appearance reports, then COLORFGBG. Auto follows live terminal updates.
# Falls back to dark when detection is unavailable.
theme: auto

# Environment variable defaults. Supported configuration is limited to Yukino-specific
# YUKINO_* test/integration inputs and OTEL_*, LANGFUSE_*, SENTRY_* telemetry settings.
# Product settings use the typed YAML fields above. Other environment
# variables are read-only inputs from the host environment; configure them outside this block.
# Explicit environment always wins, including an explicitly empty string. Scalars are
# stringified (1 → "1"); an empty value becomes ""; a bare `env:` is a no-op. Unset variables
# are filled before telemetry starts and on config loads. A list of single-key mappings
# (`- KEY: value`) is also accepted. See the variable reference below for scope and defaults.
env:
  # ── E2E test settings ────────────────────────────────────────────────────────────
  # YUKINO_TEST_API_KEY: test-key     # Enables the real-provider memory consolidation test
  # YUKINO_TEST_BASE_URL: https://api.deepseek.com # Default test provider endpoint
  # YUKINO_TEST_MODEL: deepseek-flash # Default test model
  # YUKINO_TEST_PROTOCOL: openai-compat # anthropic | openai | openai-compat (default)
  # ── OpenTelemetry — see the Telemetry section; telemetry stays off without exporters ─
  # OTEL_SDK_DISABLED: "true"         # true disables OpenTelemetry and Langfuse tracing
  # OTEL_SERVICE_NAME: yukino         # Service name; defaults to yukino
  # OTEL_RESOURCE_ATTRIBUTES: deployment.environment.name=production
  # OTEL_TRACES_EXPORTER: otlp        # Comma-separated: otlp | console | none
  # OTEL_LOGS_EXPORTER: otlp          # Comma-separated: otlp | console | none
  # OTEL_METRICS_EXPORTER: otlp       # Comma-separated: otlp | console | prometheus | none
  # OTEL_EXPORTER_OTLP_PROTOCOL: http/protobuf # Shared protocol: grpc | http/json | http/protobuf
  # OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: http/protobuf # Per-signal protocol overrides
  # OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: http/protobuf
  # OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: http/protobuf
  # OTEL_EXPORTER_OTLP_ENDPOINT: https://collector.example.com # Shared collector endpoint
  # OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: https://collector.example.com/v1/traces
  # OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: https://collector.example.com/v1/logs
  # OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: https://collector.example.com/v1/metrics
  # OTEL_EXPORTER_OTLP_HEADERS: authorization=Bearer token
  # OTEL_METRIC_EXPORT_INTERVAL: 60000 # Metric export interval in ms; defaults to 60000
  # ── Langfuse — enabled when both keys are set ──────────────────────────────────────
  # LANGFUSE_PUBLIC_KEY: pk-lf-xxx
  # LANGFUSE_SECRET_KEY: sk-lf-xxx
  # LANGFUSE_BASE_URL: https://cloud.langfuse.com # Cloud or self-hosted endpoint
  # LANGFUSE_TRACING_ENVIRONMENT: production      # Environment attached to traces
  # LANGFUSE_RELEASE: 1.0.0                       # Defaults to the Yukino version
  # LANGFUSE_FLUSH_AT: 15                         # Spans accumulated before export
  # LANGFUSE_FLUSH_INTERVAL: 0.5                  # Batch flush interval in seconds
  # LANGFUSE_TIMEOUT: 3                           # Export request timeout in seconds
  # ── Sentry — enabled when SENTRY_DSN is set ────────────────────────────────────────
  # SENTRY_DSN: https://xxx@yyy.ingest.sentry.io/1
  # SENTRY_ENVIRONMENT: production
  # SENTRY_RELEASE: 1.0.0                         # Defaults to the Yukino version
  # SENTRY_DEBUG: "true"                          # true enables Sentry SDK diagnostics

# Optional MCP examples: all disabled. Install/configure a trusted server yourself before
# explicitly setting enabled: true. The starter has mcp_servers: [].
# Trusted project entries replace matching global names; call-level arrays replace both.
mcp_servers:
  - name: local-direct # Server names must be unique
    enabled: false
    command: /absolute/path/to/your/mcp-server # stdio executable, not a shell command
    args: [] # Optional executable arguments
    exposure: direct # Tool schemas are exposed directly to the model
    tool_exposure: # Exact matches win; otherwise the first matching wildcard wins
      - tool: "dangerous_*"
        exposure: hidden
  - name: local-deferred
    enabled: false
    command: /absolute/path/to/your/mcp-server
    exposure: deferred # Discover through ToolSearch; native or McpCall wire adaptation
    # Child environment (stdio only). ${VAR}, ${VAR:-default}, $VAR are expanded only when
    # connecting; an unset variable without a default fails that enabled connection.
    env:
      API_KEY: "${YUKINO_MCP_API_KEY}"
  - name: http-codemode
    enabled: false
    url: "http://localhost:3300/mcp" # Exactly one of command | url per active server
    transport: http # Streamable HTTP; default for URL servers
    exposure: codemode # CodeMode only; also requires code_mode.mode: on or only
    # Headers for URL servers use the same variable expansion as env.
    headers:
      Authorization: "Bearer ${YUKINO_MCP_API_KEY}"
  - name: http-hidden
    enabled: false
    url: "http://localhost:3300/mcp"
    transport: http
    exposure: hidden # No tool invocation; hidden is not a server-disabling switch

# OS-level sandbox wrapping Bash commands in isolated execution
# (seatbelt on macOS, bubblewrap on Linux; unavailable elsewhere).
sandbox:
  enabled: false # Master switch
  # With the sandbox active, Bash commands skip human confirmation (explicit
  # deny/ask rules still apply; Bash tool only). Default: false.
  auto_allow: false
  network_enabled: true # Whether sandboxed commands may access the network

# Hooks are opt-in executable configuration; the starter never installs a command hook.
# Add only actions you have reviewed and intend to run.
hooks: []
```

Runtime preferences use `permission_mode` and `theme` in `config.yaml` and take effect on startup. The safe initial permission mode is `default`; `bypassPermissions` is an explicit user opt-in, never an implicit print/RPC default. MCP tools use server `exposure` (`direct`, `deferred`, `codemode`, `hidden`) and ordered `tool_exposure` rules; omitted exposure is `deferred`, and the removed `mcp_loading` setting is rejected. These exposure rules do not authorize connections or execution: keep optional servers disabled until explicitly configured and approved. Automatic TUI update checks and background task support are always enabled. Background shell tasks can be started explicitly, created on timeout, or moved from foreground with Ctrl+B when a task manager is attached.

Yukino's E2E test environment settings are:

| Variable               | Values / default                                                | Purpose                                                                                               |
| ---------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `YUKINO_TEST_API_KEY`  | Unset                                                           | Enable the E2E memory consolidation test against a real provider; without a key it is skipped.        |
| `YUKINO_TEST_BASE_URL` | `https://api.deepseek.com`                                      | Provider endpoint for that E2E test.                                                                  |
| `YUKINO_TEST_MODEL`    | `deepseek-flash`                                                | Model for that E2E test.                                                                              |
| `YUKINO_TEST_PROTOCOL` | `anthropic`, `openai`, `openai-compat`; default `openai-compat` | Select the matching Anthropic, OpenAI Responses, or OpenAI Chat Completions client for that E2E test. |

The standalone test runner reads `YUKINO_TEST_API_KEY`, `YUKINO_TEST_BASE_URL`, `YUKINO_TEST_MODEL`, and `YUKINO_TEST_PROTOCOL` from its process environment and does not load `config.yaml`; export them before running the E2E test. The protocol must match the provider endpoint; an unsupported value fails validation. CLI environment defaults fill only unset variables. Restart Yukino to change or remove a default that has already been applied.

Yukino also sets the following variables for hooks, native helpers, and test infrastructure. These are internal process inputs, managed by their caller rather than user configuration:

| Variable                   | Set by             | Value                                                                           |
| -------------------------- | ------------------ | ------------------------------------------------------------------------------- |
| `YUKINO_EVENT`             | Hook runner        | Current hook event name.                                                        |
| `YUKINO_TOOL`              | Hook runner        | Current tool name, or an empty string when absent.                              |
| `YUKINO_FILE_PATH`         | Hook runner        | Current file path, or an empty string when absent.                              |
| `YUKINO_COMPUTER_INPUT`    | Computer-use tool  | Base64-encoded JSON action passed to macOS and Windows native helpers.          |
| `YUKINO_COMPUTER_ASSEMBLY` | Computer-use tool  | Temporary Windows helper assembly path for compilation and execution.           |
| `YUKINO_SCREENSHOT_PATH`   | Computer-use tool  | Temporary output path for a Windows screenshot.                                 |
| `YUKINO_CLIPBOARD_PATH`    | Clipboard reader   | Temporary output path for a Windows clipboard image.                            |
| `YUKINO_TEST_HOME`         | Test setup         | A fresh temporary home directory for each test; used by the mocked `homedir()`. |
| `YUKINO_LIB_ENTRY`         | Library entry test | File URL of the built library imported by the child Node.js process.            |

The companion [Yukino MCP server](../mcp/README.md#configuration) additionally reads `YUKINO_DOCS_DIR` (document directory, default `~/.yukino/docs`) and `YUKINO_INDEX_DB` (index database, default `~/.yukino/index.sqlite`). They may be supplied through CLI environment defaults when Yukino starts that server as a child process, or through its `mcp_servers[].env`. The examples use `YUKINO_MCP_API_KEY` and the repository's `mcp.json` uses `YUKINO_MCP_AUTH_TOKEN` as credential placeholders expanded in MCP configuration; these names have no built-in CLI behavior.

Other environment variables are read-only inputs to Yukino and belong in the host environment, outside the global `env` block. These include provider key fallbacks (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) and IDE integration (`CLAUDE_CODE_SSE_PORT`, `CLAUDE_CONFIG_DIR`, default `~/.claude`). Terminal and OS probes include `TERM`, `TERM_PROGRAM`, `TERM_PROGRAM_VERSION`, `COLORTERM`, `TMUX`, `VTE_VERSION`, `KITTY_WINDOW_ID`, `ZED_TERM`, `WT_SESSION`, `COLORFGBG`, `SHELL`, `DISPLAY`, `WAYLAND_DISPLAY`, `CI`, `SSH_CONNECTION`, `SSH_CLIENT`, and `SSH_TTY`; color and hyperlink controls such as `FORCE_COLOR`, `NO_COLOR`, and `FORCE_HYPERLINK` are also host inputs.

Main agents, subagents, and teammates use the same path sandbox policy: read-only tools can access paths outside the working directory without path approval. Writes outside the agent's working directory, the system temp directory, or an explicitly allowed root require approval unless an explicit allow rule applies. `bypassPermissions` disables this path sandbox; switching back restores it. Explicit deny/ask rules and an agent's own plan approval lock still apply. The OS-level Bash sandbox is separate and remains controlled by the `sandbox` configuration or the TUI's `/sandbox` command. Isolated worktree agents instead receive their own worktree write root, without the parent workspace or a shared system-temp write grant; per-command output directories remain writable. Explicit OS deny-write entries still take precedence.

Sandboxed worktree agents can stage and commit through their own Git metadata and branch directory, plus Git's shared object store. Parent and sibling working trees, indexes and branch refs remain outside those grants. New worktree branches use `worktree/<slug>/work` so ref locks stay in an independently writable directory. Each isolated agent uses a private temporary directory inside its Git metadata, exposed through `TMPDIR`, `TMP` and `TEMP`.

Shell rules check every executable segment separated by newlines, `;`, `&&`, `||`, `|`, and `&`, respecting literal quotes and escapes. Remembered shell rules retain the first two words plus `*`; a rule for one segment does not authorize later segments. Substitution, redirection, environment assignments (including Bash `+=`), wrappers and unsupported control syntax cannot use remembered prefixes for automatic approval. With applicable explicit restrictions, uninspectable syntax is conservatively denied or requires approval even in bypass mode. Permission dialogs show the scopes they will remember; tools without a stable scope offer one-time approval only. File rules canonicalize relative, home-relative and symlink paths before matching.

Sandbox configuration applies to TUI, print, Remote/A2A, and in-process teammates. Enabling it fails closed when the native backend is unavailable. `bypassPermissions` does not disable it. Relative allow/deny write paths resolve against the command's execution directory; home-relative paths use the same resolver as file tools. Each command runs the official `@anthropic-ai/sandbox-runtime` in a separate helper process so concurrent worktrees and background tasks keep independent policies and cleanup. Linux requires bubblewrap, socat and ripgrep; macOS uses sandbox-exec. The policy confines Bash writes; runtime convenience write roots outside the command's grants are denied. With `network_enabled: true`, outbound traffic uses the runtime's HTTP/SOCKS proxies with destinations permitted by Yukino; native runtime restrictions still apply to raw sockets and local connections. With `network_enabled: false`, outgoing connections are denied. Runtime protections for shell configuration and Git hooks also apply; it does not wrap PowerShell or MCP executables.

Provider fields:

| Field                             | Required | Description                                                                                                                |
| --------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------- |
| name                              | yes      | Display name for the provider                                                                                              |
| protocol                          | yes      | One of: anthropic, openai, openai-compat                                                                                   |
| base_url                          | yes      | API base URL                                                                                                               |
| model                             | yes      | Model identifier                                                                                                           |
| api_key                           | no       | API key (falls back to environment variable)                                                                               |
| thinking                          | no       | Thinking level: off, minimal, low, medium, high, xhigh, max (default: `high` for every protocol).                          |
| reasoning                         | no       | Explicit capability switch: `false` disables reasoning entirely; omitted leaves the provider default in place.             |
| sampling_params                   | no       | JSON object merged into OpenAI Responses / OpenAI-compatible request bodies. Ignored by Anthropic.                         |
| sampling_params_by_thinking_level | no       | Sampling overrides keyed by off/minimal/low/medium/high/xhigh/max, selected after the logical thinking level is clamped.   |
| thinking_level_map                | no       | Per-level overrides mapping a logical level to a provider effort string (or `null` to disable that level).                 |
| thinking_mode                     | no       | Anthropic only: `budget` (default) or `adaptive`; adaptive sends effort-based `output_config` instead of a token budget.   |
| context_window                    | no       | Context window in tokens (default: 1000000; no model-name inference)                                                       |
| max_output_tokens                 | no       | Output cap for the model (default: 128000, never above `context_window`). Set this for models with a smaller output limit. |

The thinking level controls reasoning depth. For `anthropic` in the default `budget` mode it maps to a thinking token budget (minimal 1024, low 2048, medium 8192, high 16384, xhigh 32768, max 65536); with `thinking_mode: adaptive` it maps to an effort-based `output_config` instead (minimal resolves to low, xhigh to high). For `openai` and `openai-compat`, off through high map to the matching provider reasoning effort; xhigh and max collapse to high unless `thinking_level_map` explicitly maps them to a provider-supported value. The budget shares `max_output_tokens` and always leaves at least 1024 answer tokens, so lower `max_output_tokens` shrinks the thinking budget instead of disabling it (below a 2048-token cap no valid budget remains and thinking falls back to disabled). Levels the model does not support are declared through `thinking_level_map` (map to a supported effort, or `null` to disable) and `reasoning: false`; an unsupported request is clamped down to the nearest available level. Use `/thinking <level>` to change it at runtime (the change is applied to the active client and saved to `~/.yukino/config.yaml`), or bare `/thinking` to open a picker of the levels the active provider supports.

Sampling merge order is `sampling_params` → the effective level in `sampling_params_by_thinking_level` → `LLMStreamOptions.samplingParams`. Trusted project overrides merge with the same provider's global defaults per key and per thinking level; changing the model or endpoint clears inherited model metadata. Overrides replace individual keys, including explicit `null`; they do not mutate configuration. These fields pass through as JSON without name translation, so choose parameters supported by your endpoint. As in PI, sampling keys merge last and can override named request fields. Anthropic ignores this OpenAI-specific configuration.

```yaml
sampling_params:
  temperature: 0.6
  top_p: 0.9
  top_k: 40
sampling_params_by_thinking_level:
  off:
    temperature: 0.2
  high:
    temperature: 0.8
    top_k: 60
```

API keys are resolved in this order: explicit api_key field, then environment variables (ANTHROPIC_API_KEY for anthropic, OPENAI_API_KEY for openai and openai-compat).

Hook conditions (`condition`; omitted means the hook always fires):

A condition is a JavaScript expression evaluated against the hook context; a truthy result fires the hook. These variables are in scope:

| Variable   | Type   | Value                                                     |
| ---------- | ------ | --------------------------------------------------------- |
| `event`    | string | Event name, e.g. `pre_tool_use`                           |
| `tool`     | string | Tool name (`""` for non-tool events)                      |
| `filePath` | string | The tool's `file_path`/`path` argument (`""` when absent) |
| `message`  | string | Event message (`""` when absent)                          |
| `args`     | object | The tool's arguments, e.g. `args.command`                 |

Examples: `tool === "EditFile"`, `["EditFile", "WriteFile", "Bash"].includes(tool)`, `/\.ts$/.test(filePath)`, `event.endsWith("tool_use") && !tool.startsWith("Read")`.

Expressions that fail to compile or throw at runtime (syntax errors, misspelled method names, undefined variables) are logged and treated as false, so the hook is skipped.

### Telemetry

Telemetry is disabled by default and is configured only through environment variables. Yukino's OpenTelemetry and Langfuse instrumentation does not send prompts, model output, thinking content, tool arguments, tool results, file paths, API keys, or raw session IDs. Session identifiers included in traces are hashed. Sentry separately sends exception diagnostics as described below.

#### OpenTelemetry

Set at least one exporter variable to enable OpenTelemetry:

| Variable                              | Values / purpose                                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `OTEL_SDK_DISABLED`                   | Set to `true` to disable OpenTelemetry and Langfuse tracing.                                                        |
| `OTEL_SERVICE_NAME`                   | Service name; defaults to `yukino`.                                                                                 |
| `OTEL_RESOURCE_ATTRIBUTES`            | Comma-separated resource attributes, for example `deployment.environment.name=production`.                          |
| `OTEL_TRACES_EXPORTER`                | Comma-separated `otlp`, `console`, or `none`.                                                                       |
| `OTEL_LOGS_EXPORTER`                  | Comma-separated `otlp`, `console`, or `none`.                                                                       |
| `OTEL_METRICS_EXPORTER`               | Comma-separated `otlp`, `console`, `prometheus`, or `none`.                                                         |
| `OTEL_EXPORTER_OTLP_PROTOCOL`         | Default OTLP protocol: `grpc`, `http/json`, or `http/protobuf`.                                                     |
| `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL`  | Optional trace-specific protocol override.                                                                          |
| `OTEL_EXPORTER_OTLP_LOGS_PROTOCOL`    | Optional log-specific protocol override.                                                                            |
| `OTEL_EXPORTER_OTLP_METRICS_PROTOCOL` | Optional metric-specific protocol override.                                                                         |
| `OTEL_EXPORTER_OTLP_ENDPOINT`         | Shared OTLP collector endpoint.                                                                                     |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`  | Optional trace-specific endpoint.                                                                                   |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`    | Optional log-specific endpoint.                                                                                     |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | Optional metric-specific endpoint.                                                                                  |
| `OTEL_EXPORTER_OTLP_HEADERS`          | Shared comma-separated OTLP headers. Signal-specific standard header variables are also supported by the exporters. |
| `OTEL_METRIC_EXPORT_INTERVAL`         | Metric export interval in milliseconds; defaults to `60000`.                                                        |

Example:

```bash
export OTEL_TRACES_EXPORTER=otlp
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_ENDPOINT=https://collector.example.com
export OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer token"
```

#### Langfuse

Langfuse tracing is enabled when both `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` are set. It shares Yukino's trace hierarchy with OpenTelemetry.

| Variable                       | Purpose                                             |
| ------------------------------ | --------------------------------------------------- |
| `LANGFUSE_PUBLIC_KEY`          | Langfuse project public key.                        |
| `LANGFUSE_SECRET_KEY`          | Langfuse project secret key.                        |
| `LANGFUSE_BASE_URL`            | Langfuse cloud or self-hosted endpoint.             |
| `LANGFUSE_TRACING_ENVIRONMENT` | Environment attached to traces.                     |
| `LANGFUSE_RELEASE`             | Release identifier; defaults to the Yukino version. |
| `LANGFUSE_FLUSH_AT`            | Number of spans accumulated before export.          |
| `LANGFUSE_FLUSH_INTERVAL`      | Batch flush interval in seconds.                    |
| `LANGFUSE_TIMEOUT`             | Export request timeout in seconds.                  |

#### Sentry

Sentry is enabled when `SENTRY_DSN` is set. It reports process-level errors only; performance tracing remains handled by OpenTelemetry.

Before export, Yukino removes request bodies and cookies, redacts credential fields, bearer tokens, and known secret environment values, and replaces home-directory prefixes. Cancellation errors are ignored. Exception messages and stack diagnostics remain available for debugging; this filtering does not classify every possible secret embedded in arbitrary error text.

| Variable             | Purpose                                             |
| -------------------- | --------------------------------------------------- |
| `SENTRY_DSN`         | Sentry project DSN.                                 |
| `SENTRY_ENVIRONMENT` | Deployment environment.                             |
| `SENTRY_RELEASE`     | Release identifier; defaults to the Yukino version. |
| `SENTRY_DEBUG`       | Set to `true` to enable Sentry SDK diagnostics.     |

### Project-level MCP servers (.mcp.json)

In addition to `mcp_servers` in `config.yaml`, Yukino reads a project-level `.mcp.json` from the working directory, using the following format:

```json
{
  "mcpServers": {
    "yukino-mcp": {
      "enabled": true,
      "command": "npx",
      "args": ["-y", "@yukino.js/mcp@latest"]
    },
    "remote": {
      "type": "http",
      "url": "https://example.com/mcp"
    }
  }
}
```

`enabled` defaults to `true`. Set it to `false` to skip a server before expanding its environment references, spawning a process, or making a network connection. The same field is supported on user-level `mcp_servers`. Disabling a server takes effect on `/mcp reload`. Enabled project entries connect only after project trust authorizes their current manifest. Disabling an entry is separate from trust.

Each entry takes `command`/`args`/`env` (stdio) or `url`/`headers` with `type` of `http` or `sse`. Environment references support `${VAR}`, `${VAR:-default}`, and `$VAR` in commands, arguments, environment values, URLs, and headers; an unset variable without a default prevents that server from connecting. Project entries are strictly validated before loading; malformed declarations fail explicitly. Trusted project preferences can override named user preferences, but cannot remove user deny rules or weaken mandatory sandbox policy. Project environment references use explicit project values and safe environment entries, not arbitrary global credentials. Changed executable declarations require a new matching trust decision.

Use `/mcp reload` to rebuild the active project's authorized resources. The SDK/RPC also support individual server connect, disconnect and reload. Registrations carry host-generated source/owner/scope and are revoked on disposal; borrowed resources are not closed by another session.

### Tasks, TODOs, and background work

Task tracking and task execution are separate:

- Every host (terminal, print, Remote and A2A) exposes one `TodoWrite` tool for tracking. Call `TodoWrite({})` to refresh the current board without writing. Without a team it uses the agent's private list; creating or restoring a team routes the leader to the shared board, including coordinator mode. Deleting the team restores the private list. Teammates use the shared board; ordinary subagents and forks keep independent private lists. The tool and schema remain stable across board switches.
- `TodoWrite({todos: [...]})` applies incremental edits in one atomic transaction. Items without `id` create tasks and require `subject`; status defaults to `pending` and description to an empty string. Items with an existing `id` update only submitted fields. Creation and updates both accept `description`, `status`, `owner`, `priority`, `metadata`, `blocks` and `blockedBy`. Omitted tasks and fields are retained. Empty arrays do nothing. Delete tasks explicitly with `TodoWrite({deleteIds: ["1"]})`; deleting removes their reciprocal dependency links. Tracking never launches work; assigning a shared task notifies its owner after commit.
- Results contain `boardId`, the complete `todos` snapshot, and a `progress` string using `DONE completed/total`; only completed items contribute to the numerator. An invalid edit rejects the entire batch without partial writes, consuming IDs, or publishing changes. Unknown fields, unknown task IDs and repeated edits to the same ID are rejected.
- Statuses are `pending`, `in_progress`, `completed`, `blocked`, and `cancelled`. `blocks` and `blockedBy` replace the specified dependency list and maintain reciprocal links; an empty array removes those links. Referenced IDs must exist before the call; forward references, self-dependencies, conflicting link edits and cycles are rejected. Starting blocked work fails atomically. Only completed dependencies unblock work; cancelled dependencies remain unresolved until their links are removed. Shared writes reload and commit under one cross-process lock. Teammates automatically claim tasks when marking them in progress, cannot take another worker's task, and cannot start a second task while one is already in progress. The leader can explicitly reassign work; stop its old worker before reassignment if it is still executing.
- Interactive/Remote/A2A private lists persist per session in `~/.yukino/sessions/artifacts/<session-id>/tasks.json`, with a stored next-ID counter so deleting or clearing items never reuses IDs on resume. Shared boards use project-scoped team storage. Corrupt or inconsistent stores fail explicitly. Print mode's private checklist lasts for that invocation. The terminal's TODO progress follows the same private list or shared board as TodoWrite, including teammate updates, blocked items, and cancelled items. When every item is completed, the progress line hides after five seconds without deleting tasks or resetting IDs. Adding or reopening an unfinished item shows it again and cancels the pending hide. Switching sessions or boards starts a fresh completion countdown.
- `Agent` executes delegated work. Background Agent/Bash/PowerShell invocations return runtime task IDs, distinct from TODO IDs. `TaskOutput` inspects one of these IDs or waits once (`wait: true`, `timeout_ms: 0..60000`). It does not consume automatic completion notifications or stop a task on timeout. Prefer notifications over polling. `TaskStop` remains the explicit cancellation mechanism.

The common built-in registry is used by terminal, print, Remote/A2A, and in-process teammates. Delegation, coordinator, and per-agent tool restrictions still filter that registry.

### File patches

`ApplyPatch({ patch })` accepts standard unified diffs with `---` / `+++` file headers and numbered `@@` hunks. Use `/dev/null` for the old path when creating a file, or the new path when deleting one. Paths are relative to the working directory or absolute; conventional `a/` and `b/` prefixes are removed. Different source and destination paths move a file. Additions require a new path. Binary patches, copies, and mode changes are rejected.

```diff
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,3 +1,3 @@
 function example() {
-  return false;
+  return true;
 }
```

Read existing sources and overwritten move destinations first. Context and deleted lines must match exactly; no whitespace or punctuation normalization is performed. Consistent LF/CRLF conversion and final-newline handling follow the diff format. All files are checked before writing, but a multi-file batch is not a transaction: failures report changes already committed. File permissions, history backups, and stale-state checks still apply.

### Workflows

`Workflow` runs a plain JavaScript script that orchestrates Yukino subagents in the background. Start with `/ultracode <task>`, invoke a named script with `/<name>`, or call the tool with one of `script`, `name`, or `scriptPath` plus JSON `args`. Named scripts live in `.yukino/workflows/<name>.js`, `.mjs`, or `.ts` in the project. TypeScript syntax is not transpiled.

```js
export const meta = {
  name: "review-files",
  description: "Review files independently, then collect the findings",
  phases: [{ title: "Review" }],
};
phase("Review");
const results = await parallel(
  args.files.map(
    (file) => () =>
      agent("Review " + file, { agentType: "review", label: file }),
  ),
);
return results.filter(Boolean);
```

Scripts receive `agent(prompt, options)`, `parallel(thunks)`, `pipeline(items, ...stages)`, `phase(title)`, `log(message)`, `workflow(name | {scriptPath}, args)`, `args`, and `budget`. A pipeline runs stages sequentially within each item while items overlap. A nested workflow may invoke agents but cannot nest another workflow. Use top-level `return` for results; imports and extra exports are rejected. Time and randomness must be supplied through args for replay. Scripts run in a QuickJS-WASI worker; metadata is parsed as a static data literal, never evaluated in Node. No host-JavaScript fallback exists. Host services still execute authorized agents and tools, so the VM is not an OS sandbox for their effects.

Agent options include JSON `schema`, `agentType`, `model`, `maxTokens`, `allowedTools`, `label`, `phase`, and `isolation: "worktree"`. Agent roles, tool restrictions, and permissions still apply. Failed agents return `null` or a recorded partial failure; scripts must handle it. A failed or uncertain agent with possible effects is not blindly executed a second time. A script can complete with partial results. Concurrent agents default to 3, with `maxConcurrency` configurable up to 16; the per-run agent-call limit is 1000. Worktree changes remain separate and are not merged automatically.

The tool returns `run_id`, `task_id`, and a saved script path. Results arrive through the normal task-notification channel; `TaskOutput` and `TaskStop` use `task_id`. Print mode waits for workflow tasks before exiting. `/workflows` opens the terminal monitor with phase and agent progress: Tab switches runs, ↑↓ selects agents, x stops one agent, K stops a run, r resumes a finished run, and Esc closes the panel. In every host, `/workflows list`, `/workflows <run_id>`, `/workflows stop <run_id>`, and `/workflows resume <run_id>` provide text controls.

Source snapshots, JSON arguments, journals, and run state live under `~/.yukino/projects/<project-key>/workflow-runs/<run_id>/`. Resume with `Workflow({resumeFromRunId: "..."})` to reuse the saved source and arguments. Supply a new source or args to override them. Matching completed bridge calls replay from the durable journal. Source divergence preserves verified results and invalidates a suffix; started calls with no recorded outcome block automatic replay of uncertain effects. Ordinary JavaScript runs again during replay. Keep side effects inside agents and keep script control flow deterministic.

### Worker lifecycle

Agent defaults to `kind: "teammate"`, joins the selected team or creates one automatically when none exists, and generates the teammate name from its description. Multiple teams can coexist; pass `team_name` when multiple teams exist. Use `kind: "subagent"` for one-shot runs and `worktree: true` for Git worktree isolation; agent definitions also accept a boolean `worktree` default, which a call can override. The optional `model` field is unnecessary for most tasks. `TeamCreate` adds a team, named via its optional `name` parameter or auto-generated when omitted, and keeps existing teams running. `TeamList` lists all teams. Use `team_name` with Agent, SendMessage, TodoWrite, TaskStop, and TeamDelete to select the target team; when only one team matches, it can be omitted. Teammates always send messages and edit tasks within their own team. The progress display combines tasks from all teams.

`Agent` selects its role and context independently: `subagent_type` defaults to `"general-purpose"`, while `fork` defaults to `true` for every role.

| Parameters                           | Role            | Initial context                 |
| ------------------------------------ | --------------- | ------------------------------- |
| `subagent_type: "plan", fork: true`  | plan            | Copy of the parent conversation |
| `subagent_type: "plan", fork: false` | plan            | Fresh conversation              |
| `fork: true`                         | general-purpose | Copy of the parent conversation |
| `fork: false`                        | general-purpose | Fresh conversation              |

The same combinations work for other built-in and user-defined roles. Role tool restrictions, permissions, models, and `max_turns` apply in either context mode. `run_in_background` separately controls one-shot scheduling. For persistent teammates, `fork` seeds the initial conversation once; later assignments reuse the teammate's own history. Forking copies the conversation without sharing subsequent changes, and closes pending parent tool calls only in the copied transcript.

Ordinary subagents run once. On completion, failure, or interruption, the host waits for their owned background commands to stop and releases their scoped tool registry. Parent-owned MCP tools are borrowed, not shut down by a child. Background task records and subagent transcripts persist under `~/.yukino/sessions/artifacts/`; `TaskOutput` includes the transcript path and timestamps. Finished results remain queryable from disk after the in-memory retention limit, and delivered notifications are recorded in the leader's session. Resuming restores terminal outcomes and reports abandoned running tasks as interrupted failures. Iteration-limit and model failures preserve partial text alongside the error and transcript. Cancellation callbacks are discarded when runners settle. A fork cannot create or replace teams, or stop parent-owned work.

An explicit `run_in_background: false` overrides a predefined agent's `background: true`; when omitted, the definition supplies the default, independently of `fork`. Role files accept a UTF-8 BOM before frontmatter. Delegated agents cannot manage the main session's persistent goal.

Ordinary subagents have no default model-turn limit. Role files can set a positive `max_turns` to impose one. Fresh and inherited conversations, foreground and background execution all use the selected role's limit. Reaching a configured limit reports failure with partial output and a transcript path; it does not mark the assignment complete.

Persistent teammates become idle after each turn. They keep conversation context and access to the shared task board for follow-up assignments, but must send findings with `SendMessage`; final text is not automatically forwarded to the leader. They exit on explicit shutdown, cancellation, failure, or loss of the leader. Exit clears live permission/cancellation references, releases owned tools, and resets unfinished owned tasks to unassigned/pending. Completed and cancelled records remain intact. Teammate task ownership is not released merely because a turn becomes idle.

The team retains at most 200 terminated member summaries; running and idle members are never evicted. Agent generates unique teammate names among retained members.

#### Delegated permission model

Agent definitions support `permission_mode: default | acceptEdits | plan | bypassPermissions`. Subagents and teammates use **rank-based permission composition**, with three distinct values:

- **Own permission mode** (`ownMode`): the child's stored, mutable mode. It is initialized from the agent definition's `permission_mode`, or set to `plan` when an Agent is spawned with `kind: "teammate"` and `subagent_type: "plan"`; omitted values remain unset. Leader approval can replace this value with the approved execution mode, as can automatic plan approval outside coordinator mode. Changes to the parent's mode do not rewrite it.
- **Parent effective mode** (`parentMode`): the current effective mode of the immediate parent agent, such as the main agent or team leader.
- **Effective permission mode** (`effectiveMode`): the mode used for the child's tool permission checks, computed from its own mode and the parent's effective mode.

Permission ranks define the composition order:

| Rank | Modes               |
| ---- | ------------------- |
| 1    | `default`, `plan`   |
| 2    | `acceptEdits`       |
| 3    | `bypassPermissions` |

Subject to the mandatory constraints below, the effective rank is the maximum of the child's own rank and the parent's effective rank. An unset own mode contributes `default`:

```text
rank(effectiveMode) = max(rank(ownMode ?? default), rank(parentMode))
```

The selected rank resolves to `bypassPermissions` at rank 3 and `acceptEdits` at rank 2. At rank 1, the child's own mode determines the result, with `default` used when unset. `default` and `plan` share a rank but retain distinct execution policies; a parent in `plan` does not implicitly place an unspecified child in plan mode.

Resolution is dynamic on each permission check, including during foreground, background, fork, and worktree runs. Parent mode changes recompute the child's effective mode without changing its stored own mode. Child mode changes do not change the parent or sibling agents. The resulting mode matrix is:

| Child's own mode  | Parent default    | Parent acceptEdits | Parent bypassPermissions | Parent plan       |
| ----------------- | ----------------- | ------------------ | ------------------------ | ----------------- |
| Omitted           | default           | acceptEdits        | bypassPermissions        | default           |
| default           | default           | acceptEdits        | bypassPermissions        | default           |
| acceptEdits       | acceptEdits       | acceptEdits        | bypassPermissions        | acceptEdits       |
| bypassPermissions | bypassPermissions | bypassPermissions  | bypassPermissions        | bypassPermissions |
| plan              | plan              | acceptEdits        | bypassPermissions        | plan              |

Mandatory policy constraints take precedence over rank composition:

- **Permanent read-only roles:** built-in `explore` workers and one-shot `plan` subagents always use `plan`, including follow-up assignments. Parent modes and plan approval cannot grant them execution permissions.
- **Coordinator plan approval:** a teammate required to submit a plan for leader review remains in `plan` until approved, even when the leader uses `acceptEdits` or `bypassPermissions`.

Permission composition selects a mode; tool availability, explicit permission rules, and applicable sandbox policies still govern individual operations. An effective `plan` mode blocks mutations, even through allow rules or sandbox auto-allow, except the declared plan file and internal coordination tools. `max_turns` must be a positive integer. Built-in explore uses the selected parent model unless explicitly overridden.

Teammates run only in-process and route permission requests through the main session. Requests identify the agent and working directory; remembered permission patterns apply to all agents in the project. Plan-mode definitions can use `ExitPlanMode` unless explicitly excluded by their tool restrictions; `EnterPlanMode` remains unavailable to delegated agents. One-shot planning subagents return their plans to the parent without changing its mode. In coordinator mode, teammates with `subagent_type: "plan"` stay read-only until the leader reviews the plan and sends `SendMessage(type="plan_approval_response", to=teammate, request_id=requestId, approve=true/false, content=review feedback)`. The built-in `plan` role plans and then executes as a teammate; one-shot `plan` subagents and all built-in `explore` workers remain permanently read-only and return research without entering execution approval. Rejected plans must be revised and resubmitted. Outside coordinator mode, submitted execution plans remain automatically approved. Approval writes the leader's current mode into the teammate's own mode (`default` when the leader remains in `plan`) and resumes execution under rank composition; it does not authorize subsequent tool calls. This stored mode remains available to later permission checks: a teammate approved under `bypassPermissions` retains that own mode when the leader later switches to `default`, `acceptEdits`, or `plan`. Before resuming execution or plan revision, the host includes queued ordinary team messages with the review feedback so scope corrections are applied in that next turn. Stopped teammates release their task ownership; restored sessions mark old runtimes inactive and reclaim unfinished work. Edited worktrees are retained for explicit integration, not deleted as part of runtime cleanup. Agent teammate calls reuse the selected team; an explicit TeamCreate adds another team without stopping or deleting existing teams. TeamDelete stops and removes only the selected team.

Bash and PowerShell commands recognized by `isSafeCommand` can run in parallel. Unrecognized commands and file mutations share a process-wide FIFO queue keyed by canonical working directory, so agents in the same workspace cannot perform these operations simultaneously. Independent worktree directories have independent queues. Queued operations can be cancelled and recheck permissions before starting. Background commands hold their workspace slot until the tracked shell exits; moving a command to the background does not release it.

`WebFetch` uses `lru-cache` with a 15-minute TTL and a 50 MiB byte budget including content, URLs and keys. Reads update recency. It cancels discarded response bodies and honors cancellation even for cached pages. Direct HTTP/HTTPS access, including project intranet endpoints, remains supported.

Common infrastructure uses maintained libraries: `diff` for line comparison and hunks, `acorn` for static Workflow metadata syntax, `p-queue` for task scheduling, `write-file-atomic` for file replacement, `glob` for generic file scanning, `shell-quote` for command tokenization, `semver` for release comparison, and Express for static browser assets. Yukino extracts YAML frontmatter between standalone `---` lines and parses the metadata with `js-yaml`. Terminal Markdown uses `marked-terminal`, with Shiki and `cli-table3` adapters for code and Unicode-aware cell wrapping.

Shell tokenization follows shell-quote syntax. Quote Windows paths in single quotes and use double quotes around text containing apostrophes. Prompt-template arguments preserve variable names without expanding the host environment. Permission analysis uses parsed command segments; expansions, redirects and syntax it cannot resolve still require explicit approval. It does not inspect the contents of shell interpreter arguments or apply an executable blacklist. Explicit allow/deny rules and permission modes remain in force.

File locks retain the in-house ticket-based implementation with process-liveness checks. Live owners are not evicted solely because their tickets are old; Code Mode and Workflow execution locks reclaim dead owners immediately. Atomic writes preserve file modes, and private state stays restricted to its owner. Cancellation is checked before write admission and temporary-file creation; an admitted atomic commit may finish after cancellation. Git directory, HEAD and branch queries use Git's `rev-parse` and `symbolic-ref` commands, including support for Git-managed reference storage. Diff calculation has a one-second budget; exceeding it omits the preview and reports that line counts are unavailable.

### Persistent goals

`/goal <objective>` sets a goal and starts work. `/goal` or `/goal status` reports its state. The goal is stored in the session JSONL, survives compaction and `/resume`, and follows conversation checkpoint rewind. `/clear` starts a separate session. Merely reopening a session does not start unattended work.

```text
/goal --budget 100000 Implement the feature and verify every acceptance criterion
/goal pause
/goal resume
/goal replace --budget 150000 Finish the revised objective
/goal complete
/goal clear
```

After a normal model turn ends, an active goal starts another turn. Pending user input takes priority; Plan mode, interruption, and provider failures do not trigger automatic continuation. Pause and clear controls take effect during streaming without cancelling the current request. A user-set goal is already `active`; the model's `Goal` tool can inspect it or report `in_progress`/`complete`/`blocked` with a reason. Reporting `in_progress` keeps an active goal active and resets its blocker audit; it cannot resume a paused or stopped goal. Only the user can set, replace, pause, resume, or clear a goal. Completion requires evidence for the whole objective. The same blocker must be recorded on three consecutive goal turns, once per turn, before continuation stops. Resuming a blocked goal starts a fresh audit.

The optional token budget counts input, output, cache-read, and cache-creation tokens for the main conversation's model requests during the goal run, including its final response. Delegated agents, memory selection, and compaction summaries are outside this counter. An in-flight request can exceed the budget; once reported, substantive work stops. Yukino makes at most one final model request with no tools to summarize verified progress, unfinished work, and blockers. Its tokens are included in the counter. The request is not retried or continued if it fails or hits its output limit. Pending user input, Plan mode, and interruption take priority; an undelivered summary remains pending across session resume. The goal remains `budget_limited` and requires explicit replacement with a new budget. The 150-turn limit requires `/goal continue` to reset it. Active time excludes idle, paused, and process-restart intervals.

TUI, Remote/A2A, and print mode share this goal loop. `yukino -p "/goal <objective>"` creates a goal for that invocation's new session. Print mode control queries finish without a model call; invalid commands return a nonzero exit code, and stream JSON retains its final `result` event.

## Usage

Run `yukino --help` (or `-h`) for a summary of all command-line options; type `/help` inside a session for the list of slash commands.

### Interactive UI Mode

```bash
yukino
yukino --resume              # open the session picker at startup
yukino --resume <session-id> # restore a specific session at startup
```

Launches the terminal interface with the provider recorded as `default_provider` in `~/.yukino/config.yaml` (the one last selected via `/provider` or `/login`; the first provider by default). Use `/provider` to switch providers at runtime. When no provider is configured, the login form opens automatically.

Use `/login` to configure and activate a provider from the UI. Name, protocol, base URL, API key, and model are required in the form. Use ↑↓ or Tab to move between fields, ←→ to select protocol or cycle the thinking level, Enter to save, and Esc to cancel. Changing the protocol keeps the thinking level; levels the new protocol cannot support display clamped to the nearest available level.

The form saves to `~/.yukino/config.yaml`, retaining existing providers and other settings. `base_url` is the provider identity: saving a provider whose `base_url` already exists replaces that entry in place instead of adding another one, and names may repeat freely. Context window accepts integers from 1000 to 10000000; max output accepts integers from 1 to 1000000 and must not exceed the context window. Empty optional fields use the defaults above.

### Print Mode (Non-Interactive)

```bash
yukino -p "explain this codebase"
yukino -p "fix the failing test" --output-format stream-json
yukino -- "--flag-like prompt text"
```

The `-p` flag uses the session SDK and prints text or typed session events with a final `result` (`--output-format stream-json`). It supports `--session`/`--resume <id>`, `--continue`, invocation model/tool/system-prompt controls, stdin (`-p -`) and `--no-persist`. Print has no implicit permission bypass: requests needing permission, questions or plan approval fail without preauthorization. Use trusted user policy or an explicit `--permission-mode` rather than putting API keys in argv.

JSONL output includes incremental `stream_text` and `thinking_text`, tool lifecycle events paired by `tool_id`, cache usage, retry/compaction events, completion events, and a final `result`. SIGINT and SIGTERM cancel owned background tasks and retain exit codes 130 and 143. Put options before `--`; tokens after it are prompt data. CLI options and help are defined with [Commander](https://github.com/tj/commander.js). Repeated scalar options use the last value; `--attachment` accumulates files. A single dash-prefixed prompt can also be supplied as the required value of `-p`.

### Remote Mode (Browser UI)

```bash
yukino --remote                  # listens on 127.0.0.1:18888
yukino --remote 9000             # custom loopback port (":9000" also works)
yukino --remote 0.0.0.0:9000      # explicitly expose on all interfaces (no built-in authentication)
yukino --remote 0                # OS-assigned ephemeral port; the actual URL is printed on startup
```

Starts an Express HTTP server and WebSocket bridge. The bundled React frontend is served at the configured address for browser-based interaction. With port 0 the OS picks a free port and the server prints the reachable address (e.g. `Remote server listening at http://127.0.0.1:61041`) so you know where to connect.

The browser UI mirrors the terminal UI's capabilities: streaming replies and thinking, tool cards with live output, permission and ask-user dialogs, plan approval, foreground `/review` subagents, `/resume` session picker, steering messages while a turn runs (with a follow-up queue for messages that cannot steer), prompt history (`↑`/`↓`), `@file` completion, `!`/`!!` user Bash, image attachments (paste, drop, or the attach button — stored like terminal clipboard images and expanded as `@` references), todo progress, the Agents panel (subagents, background tasks, teammates), context-window usage, and dark/light themes. Model (`/model`), provider (`/login`, `/provider`), thinking level (`/thinking`), permission mode (badge click or `Shift+Tab`), rewind (`/rewind`), sandbox (`/sandbox`), worktree (`/worktree`), MCP reload (`/mcp reload`), fork-mode skills, and `/quit` (shuts the server down) all work from the browser; `Ctrl+B` backgrounds running foreground shells and `Esc` cancels the active turn. Background tasks and teammate notifications wake an idle server the same way they do in the terminal.

Remote mode also hosts [MCP Apps](https://modelcontextprotocol.io/extensions/apps/build). Tools that declare `_meta.ui.resourceUri`, including yukino-mcp's `create_app`, display their UI below the tool card in a sandboxed iframe. The host forwards the tool input and full result (including `structuredContent` and UI-only `_meta`), applies the resource's CSP domains, and synchronizes theme and content height. Apps can read resources and call app-visible tools on their originating MCP server; tool calls use Yukino's permissions and pre-tool hooks. Open links and text messages back to the agent are supported. Apps are restored after browser refresh while the remote session remains active; clearing the transcript removes them. Saved-session resume does not restore App views.

### A2A Mode (Agent2Agent Server)

```bash
yukino --a2a                 # A2A server, listens on 127.0.0.1:18890
yukino --a2a 9000            # custom loopback port (host:port also works)
```

Serves Yukino as an Agent2Agent (`@a2a-js/sdk`) agent so other agents and orchestrators can call it. The agent card is at `/.well-known/agent-card.json`; JSON-RPC is served at `POST /` and HTTP+JSON/REST under `/v1/...`. Only A2A 1.0 is supported. Send `A2A-Version: 1.0` on every protocol request. JSON-RPC uses names such as `SendMessage`, `SendStreamingMessage`, `GetTask`, and `ListTasks`. The server only binds loopback addresses.

Each context maps to one Yukino session. Assistant text streams as artifact updates with one stable artifact ID per assistant turn; the final update replaces its deltas with the complete text. Completed tasks expose the full final reply in `status.message` and in the corresponding artifact. History contains complete assistant messages, rather than individual tokens. Thinking and tool events appear only in streaming status-update `metadata.yukino`, using the `yukino` discriminator (`thinking`, `tool-call`, `tool-result`).

`SendMessage.configuration.historyLength`, `GetTask.historyLength`, and `ListTasks.historyLength` default to 10 recent messages. REST uses the same field on send and the `historyLength` query parameter on task queries. Set it to 0 to omit history; `status.message` and artifacts still carry the answer. Request a larger value to retrieve more history. The JSON request-body limit is 100 KiB; oversized requests return a structured HTTP 413 error.

#### Yukino A2A permissions v1

The agent card declares the permission handshake as an extension, including the supported decisions. The server applies its local `permission_mode` configuration and project permission rules. Client metadata cannot elevate that policy. `default` asks before edits and commands; `acceptEdits` permits edits while commands remain subject to approval; `bypassPermissions` permits operations subject to explicit rules.

Tool permission requests surface as `TASK_STATE_INPUT_REQUIRED` status updates. `status.message.parts` contains data parts with `{ yukino: "permission-request", permissionId, toolCallId, toolName, reason, args, source? }`. `source`, when present, contains `agentName` and `cwd`; `reason` contains only the approval reason. Send a data part `{ yukino: "permission-response", permissionId, decision: "allow" | "deny" | "allowAlways" }` on the same task and context. `allowAlways` persists matching project rules for future calls, while explicit denials still apply. Answer one pending permission per message; when several tools await approval, the server re-emits the remaining requests after each decision.

### Slash Commands

Inside the UI, these commands are available:

| Command                            | Description                                                                                                                                                                                         |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| /login                             | Configure, save, and activate an LLM provider                                                                                                                                                       |
| /provider                          | Switch the active provider                                                                                                                                                                          |
| /model [model]                     | Switch the model of the current provider; without an argument, open the model picker                                                                                                                |
| /help [command]                    | Show available commands, or details for a single command                                                                                                                                            |
| /status                            | Show current session status (mode, model, provider, tokens, tools, sandbox, memories, skills, MCP, session, directory)                                                                              |
| /session                           | Confirm the session is active; use /resume to list past sessions                                                                                                                                    |
| /memory                            | List stored memories                                                                                                                                                                                |
| /memory clear                      | Clear all memories                                                                                                                                                                                  |
| /skills                            | List available skills                                                                                                                                                                               |
| /reload                            | Reload configuration preferences, hooks, prompt templates, skills, workflows, project extensions/dependencies, MCP and instruction resources; preserve the current conversation and permission mode |
| /settings                          | Search and change runtime/display preferences; ←/→ or Enter changes a value, Ctrl+S toggles saving to the selected user configuration, Esc closes                                                   |
| /retry [status / on / off / abort] | Query/toggle automatic retry or cancel only the current retry wait                                                                                                                                  |
| /skills reload                     | Hot-reload skills from disk                                                                                                                                                                         |
| /skill <name> [args]               | Run a skill by name (shorthand for `/<name> [args]`; `/skill reload` routes to `/skills reload`)                                                                                                    |
| /plan [task]                       | Run the built-in read-only plan agent synchronously with the main conversation context                                                                                                              |
| /goal [args]                       | Set or view a persistent goal; pause, resume, replace, complete, clear, or continue after the turn limit                                                                                            |
| /compact                           | Force conversation compaction                                                                                                                                                                       |
| /clear                             | Reset the session and clear the terminal                                                                                                                                                            |
| /resume [id]                       | List or restore a previous session                                                                                                                                                                  |
| /rewind                            | Open checkpoint rewind dialog                                                                                                                                                                       |
| /sandbox [mode]                    | Configure sandbox (auto=on+auto, manual=on+manual, off)                                                                                                                                             |
| `/ultracode <task>`                | Ask the main agent to create and execute a multi-agent workflow for the task                                                                                                                        |
| `/workflows`                       | Open the terminal workflow monitor; in other hosts, list workflow runs                                                                                                                              |
| `/workflows list`                  | List workflow run IDs, names, statuses, agent counts, and task IDs                                                                                                                                  |
| `/workflows <run_id>`              | Show a workflow run's status, result, or error                                                                                                                                                      |
| `/workflows stop <run_id>`         | Stop a running workflow and cancel its agents                                                                                                                                                       |
| `/workflows resume <run_id>`       | Resume a saved workflow using its script, JSON arguments, and journal                                                                                                                               |
| /worktree                          | List git worktrees                                                                                                                                                                                  |
| /mcp                               | Show MCP server status                                                                                                                                                                              |
| /mcp reload                        | Re-read MCP config; disconnect every server and reconnect the freshly read list                                                                                                                     |
| /thinking [level]                  | Without an argument, open a picker of the supported thinking levels; with one, set the level (off, minimal, low, medium, high, xhigh, max). The setting persists to `~/.yukino/config.yaml`         |
| /review [PR or URL]                | Review a pull request in a foreground subagent; without arguments, list open PRs                                                                                                                    |
| /quit                              | Exit the application                                                                                                                                                                                |

`/ultracode` gives the main agent workflow orchestration instructions. The agent scopes the task, writes a JavaScript workflow, and invokes the `Workflow` tool. Agents run in the background with a default concurrency of 3; their final result returns through a task notification.

```text
/ultracode Review the current changes for correctness, security, and test coverage; verify the findings and summarize.
/workflows
/workflows list
/workflows <run_id>
/workflows stop <run_id>
/workflows resume <run_id>
```

Replace `<run_id>` with the `run_id` returned by `Workflow` or listed by `/workflows list`. These commands use workflow run IDs; `TaskOutput` and `TaskStop` use the separate `task_id`. Resuming replays matching recorded outcomes without repeating effects. Started calls without a durable outcome are uncertain and block automatic retry; source changes invalidate only a verified divergent suffix. Completed replays do not create duplicate tasks, notifications or fees.

In the terminal monitor, Tab/Shift+Tab switches runs, ↑/↓ selects agents, x stops the selected agent, K stops the whole workflow, r resumes a finished run, and Esc/q closes the monitor. Stopping work requires confirmation in the monitor. See [Workflows](#workflows) for script primitives, named workflows, and persistence details.

### User Bash Commands

Start the main terminal input with `!` or `!!` to execute Bash directly, without calling the model. `! git status` includes the command and result in the next model context; `!! pnpm test` excludes both from model context. Commands are literal shell input: `@` references, slash commands, and skills are not expanded. Plan feedback and other dialogs do not interpret these prefixes.

The command runs in the current workspace with Yukino's Bash timeout and output limits. Output appears while it runs, and Ctrl+O expands the tool card. Results retain at most the last 2,000 lines / 50 KiB; larger output is saved to a file whose path appears in the result. Prompt history supports recalling commands. Both modes persist their cards for `/resume` and checkpoint rewind, while `!!` results remain excluded when rebuilding model context. Agent permission modes (including Plan) do not restrict commands explicitly entered by the user; an enabled OS sandbox still applies and fails closed if unavailable.

Commands can run while the model is streaming, with at most one user command at a time. Completed results wait until the current model turn or compaction finishes before entering session history and model context, preserving tool-call/result ordering. Esc or Ctrl+C cancels the user command first without stopping the model or background agents. New idle chat turns and slash commands wait for it to finish. User commands cannot be moved to the background with Ctrl+B and never produce model-facing task notifications.

### Keyboard Shortcuts

| Key       | Action                                                                              |
| --------- | ----------------------------------------------------------------------------------- |
| Ctrl+C    | Clear input or interrupt streaming (first press), exit app (second press within 2s) |
| Ctrl+O    | Toggle full vs. truncated tool output                                               |
| ↓         | On the last input line, view all teammates and background subagents                 |
| Ctrl+B    | Move running foreground Bash/PowerShell tasks to the background                     |
| Ctrl+V    | Paste a clipboard image (Alt+V on Windows)                                          |
| Shift+Tab | Cycle default → acceptEdits → bypassPermissions → default                           |

Run `/plan` to plan the current task, or `/plan <task>` to specify a planning request. In interactive terminal and browser sessions, both `/plan` and the main agent's `EnterPlanMode` tool run the built-in read-only `plan` agent synchronously in the foreground with a fork of the main conversation. The host saves the returned plan and presents it for user approval before implementation. Failed or cancelled planning does not open approval. `Shift+Tab` and the browser's permission-mode badge only cycle the three execution permission modes; from plan mode, they return to `default`.

Press ↓ on the last visual row of the input to view all teammates and background subagents, including while the foreground agent is streaming. Completion menus and prompt-history navigation take precedence. Enter opens an agent's details, Escape returns or closes the list, and the unsent draft and cursor are preserved. Teammate spawn cards scroll with the transcript like background subagent cards; current progress is available in the Agents list.

Terminal and browser UI share Catppuccin Mocha (dark) and Latte (light) palettes. Named foundation colors feed shared semantic tokens for both interfaces. Mauve identifies focus and progress, blue and mauve separate user and system messages, and tool cards use blue while running, green on success, and red on failure. Stopped terminal tool cards use yellow. Tinted surfaces and readable foreground shades are derived from the same palette. Automatic terminal appearance uses the reported background and foreground first, then a light/dark report, then `COLORFGBG`, and defaults to dark. Supporting terminals notify Yukino when their appearance changes; history, live output, and dialogs update together. Explicit light or dark settings remain fixed. Messages, tool cards, Markdown, and dialogs retain generous spacing, with layouts adapting to smaller terminals and screens.

The terminal uses native scrollback. Scroll with the mouse wheel or trackpad, drag to select, and use the terminal's copy/paste shortcuts. The input and footer scroll out of view while reading history; new-output following and scrollback retention depend on the terminal. Up/Down navigates completion menus, visual input rows, and prompt history. Home/End and Ctrl+A/E move within the input line; PageUp/PageDown use the terminal's bindings.

Completed messages stay in scrollback when the terminal resizes; live text, tools, input, and status use the current dimensions. Markdown tables wrap cells and fall back to raw Markdown when a grid cannot fit. Ctrl+O rebuilds the transcript with expanded or collapsed details; clear, resume, and rewind also rebuild it, clearing the prior screen and scrollback.

Pastes longer than 10 lines or 1,000 characters collapse to `[paste #1 +124 lines]` or `[paste #1 1234 chars]`. Clipboard images appear as `[Image #1]`. Arrow keys move across each placeholder as a unit, and Backspace/Delete remove it as a unit. Placeholders survive dialog switches; submitting restores the full text and image attachments.

Pasting an image saves it as a PNG under `~/.yukino/sessions/artifacts/<session-id>/file-history/`. Its placeholder expands to a cwd-relative `@` reference on submit and loads as an inline image block. Linux requires `wl-clipboard` (Wayland) or `xclip` (X11).

## Project trust and session trees

Project preferences live in `.yukino/config.yaml`; prompts, skills, MCP and workflows retain their dedicated directories/files. Startup first discovers a bounded manifest, then applies trusted preferences. Invocation settings win over trusted project preferences, user configuration and defaults. User deny rules, mandatory sandbox policy and credential storage are not project preferences. New endpoints do not inherit global provider/MCP secrets.

Trust can be granted once or persisted for the exact canonical path and manifest, denied or revoked. Without an interaction callback, untrusted executable resources are skipped. `--trust-project` authorizes only the current invocation; `--no-project-resources` disables them. Trust is not an OS sandbox: an explicitly loaded Node extension, hook or MCP executable has its host privileges.

Session storage is a versioned append-only tree with stable entry/parent IDs and an active leaf. `/tree` selects a branch without deleting the departed path. Selecting a user message returns to its parent and refills that input; tool batches stay paired. `/tree --summary [description]` explicitly requests a paid, cancellable summary of only the departed divergent path. Files are not restored by navigation: `/rewind` file restoration remains a separate confirmed action.

Inside `/resume`, `Ctrl+R` renames the focused session and `Ctrl+D` opens deletion confirmation (`Y` confirms; `N`/Escape cancels). The active session cannot be deleted, and leased sessions retain the maintenance service's protection. `Ctrl+S` cycles recent activity / modified time / name sorting, including during search; `Ctrl+A` toggles this project / all projects, `Ctrl+N` toggles named sessions, `Ctrl+P` toggles paths, and `Ctrl+X` includes archived sessions. `Ctrl+K` shows the available controls. Rename preserves tags and archive state. In `/tree`, `Ctrl+F` cycles all / no-tools / user-only / labeled-only, `Ctrl+L` shows labels plus the active branch, arrows fold individual branches, and `Ctrl+E` / `Ctrl+O` fold / unfold all. The no-tools view retains assistant explanations alongside tool calls while hiding results, tool-only calls and bookkeeping; user-only excludes user shell executions. Filters change the display; navigation continues to preserve complete tool batches.

Compaction and branch summary payloads include structured `details: { readFiles, modifiedFiles }`. Successful ReadFile, WriteFile, EditFile and ApplyPatch operations declare normalized absolute paths; moves include both source and destination, and patch failures retain paths already committed. Modified files take precedence over read files. The sets accumulate across summaries and appear deterministically in model-visible context; branch summary details remain separate from the model's prose limit. CodeMode preserves nested declarations even when a later script step fails, output exceeds its bridge limit, or recovery refuses to resume. Custom tools can declare completed operations through `structuredContent.fileOperations` using the same two arrays and absolute paths; undeclared Bash/custom-tool side effects and failed operations without declarations are not guessed from output text. Export/import preserves this metadata, including Windows paths on other hosts, `[workspace]` and `[local-path]` references in portable/redacted records. These are historical references, never execution paths or file restoration instructions.

`/name`, `/fork`, `/clone`, `/import`, `/export` and `/diagnostics` expose local session organization. Fork copies the path before a selected user message; clone copies the active path. Imports and copied control history never start old Goals, scripts, tools or processes. Old session/journal formats fail explicitly and are retained, not silently converted or erased.

JSONL exports can contain the active path or full tree, verified portable artifacts and historical cost provenance. HTML is self-contained and offline, with content escaped and scripts from messages never executed. Export and overwrite use the file permission pipeline; review redaction because arbitrary text can still contain secrets. Diagnostics omit transcript unless explicitly requested. This release provides local export only, not external sharing/upload.

## Execution costs and cache warming

Every real model attempt has immutable request/run/agent/session attribution, observed usage, completeness and a price snapshot. Input tokens already exclude cached prefixes; reasoning is not charged twice. Provider-reported money and estimates are separate, unknown prices remain unknown, and currencies are not converted or combined. Memory, compaction, delegated work, branch summaries and warming have explicit purposes. Navigation does not refund paid work, and imported or cloned usage is historical rather than a new charge. Goal token budgets retain their own scope, not a global USD hard cap.

Persisted runtime ledgers use `~/.yukino/cost/<canonicalprojecthash>/<sessionhash>.jsonl`: the project hash is SHA-256 of canonical absolute `cwd`, and the session hash is SHA-256 of the session ID. Legacy project data is retained, not automatically migrated.

Prices come from explicit local provider metadata; Yukino does not fetch an automatic pricing catalogue or infer rates from model names. Missing prices remain unknown, not zero. Supply verified rates for your own endpoint, currency and effective interval. The following rates per million tokens are illustrative only, not provider pricing:

```yaml
price:
  currency: USD
  source: manual-example-not-provider-pricing
  effective_at: "2026-11-24T00:00:00Z"
  input: 1
  output: 2
  cache_read: 0.1
  cache_write: 1.25
warming:
  mode: off
```

Configure `cache.mode` as `off`, `short` or `long` only with verified protocol capability metadata. Warming (`off`, `streaming`, `idle`) defaults off and requires explicit verified replayability, TTL and price metadata. It replays a snapshot of the latest actual request, not an aggregated conversation or the assistant reply. Foreground requests preempt it; pause/budget stop, model/tree/context/registry changes, revocation and disposal cancel it. Warm requests produce at most one output token, do not retry or execute tools, and appear in the execution ledger. Best-effort TTL and expected savings are not a provider billing guarantee.

## Stdio RPC

`yukino --rpc` is the local bidirectional JSONL interface. Stdout contains protocol messages only; logs/errors use stderr. It shares the session SDK, permissions, tree, queues, costs and MCP/VM services. Frames, pending requests, output backlog and queue growth are bounded.

```json
{"version":1,"type":"request","commandId":"hello","command":"prompt","args":{"text":"Explain this project"}}
{"version":1,"type":"request","commandId":"state","command":"get_state","args":{}}
```

A prompt acknowledgement is not its completed run. Observe typed session events and `command_completed`/`command_failed`; `run_settled` differs from background task completion. Interaction messages bind permission, trust, questions, plan and OAuth replies to an interaction ID, session and deadline. Return them with `interaction_response`; stale or mismatched replies are rejected. `get_commands` lists supported controls, including model/thinking, session/tree/import/export, compaction, tasks, VM state and MCP resources/lifecycle. Abort scope and `clear_queue` are separate operations. EOF/signals/broken output stop owned work without granting new execution.

## Library Build

Besides the `yukino` CLI, the package ships a library entry for embedding Yukino in another host process. The root entry exposes named exports directly:

```ts
import { createAgentSession } from "@yukino.js/yukino/sdk";

const { session, sessionManager } = await createAgentSession({
  cwd: process.cwd(),
  provider,
  persist: true,
  onPermissionRequest: async () => "deny",
});
const unsubscribe = session.subscribe((event) => {
  if (event.type === "stream_text") process.stdout.write(event.payload.text);
});
try {
  const result = await session.prompt("Explain the current project");
  console.log(result.status, result.cost);
  sessionManager.refresh();
} finally {
  unsubscribe();
  await session.dispose();
}
```

`provider` is an explicit `ProviderConfig` with protocol, endpoint and model. A custom `LLMClient` can replace it; `examples/sdk.mjs` demonstrates an offline mock through the published package entry. `persist: false` keeps conversation records in memory and cleans owned temporary artifacts. Importing the SDK neither requires a TTY nor installs process exit/crash handlers; it is a Node API, not a browser bundle.

`steer()` accepts the same `string | PromptInput` as `followUp()`, including image-only input (`text: ""` plus `attachments`). RPC `prompt`, `steer` and `follow_up` accept `attachments` content blocks as well. Receipts, queue inspection, cancellation and persisted messages retain attachments. Steering delivers after the current tool batch and before the next model call. In the TUI, paste an image or enter an `@image` reference while a run is active; queued-message recall returns its original reference to the editor.

`AgentSession` is a stable facade: `subscribe()` returns an unsubscribe function, and `newSession()`, `resume()`, `fork()`, `clone()` and `import()` publish `session_changed` without discarding subscriptions. `steer()` and `followUp()` return receipts with a completion promise; queue delivery supports `all` and `one-at-a-time`. Use `waitForIdle()` rather than treating one text delta or `turn_complete` as completion. Background tasks report their own states. `abort()` has explicit foreground/background/queue/all scopes; clearing queued input is separate. `dispose()` is idempotent and waits for owned work, but does not destroy injected clients, registries or unrelated borrowed MCP resources.

The session API also provides tree navigation and labels, metadata/naming, compaction, model/thinking controls, execution costs, user Bash, Workflow/CodeMode state, and MCP lifecycle/resources/exposure. Missing permission, question, plan or project-trust callbacks never grant implicit permission. Model changes do not update global defaults; unknown model metadata does not inherit the previous model's prices or cache capability.

The telemetry APIs `parseExporterTypes` and `createTelemetryRuntime` are also available from the root entry. Creating a telemetry runtime loads the optional provider dependencies on demand and rejects if they are unavailable. `initializeTelemetry` manages the shared runtime and falls back to a no-op runtime when initialization fails.

Import types, classes, and functions by name rather than through module namespaces. Constants with conflicting names carry a domain prefix, such as `COMPACT_CHARS_PER_TOKEN` and `MCP_CHARS_PER_TOKEN`.

| Entry          | Output                                                                 | Contents                                                                                                                                                                                 |
| -------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI (`yukino`) | `dist/main.js`, `dist/image-worker.js`                                 | Minified ESM bundles with a separate image worker; Node built-ins, ink's `react-devtools-core` peer, WASM codec packages, sandbox runtime, ripgrep, and write-file-atomic stay external. |
| Library        | `dist/lib/index.js`, `dist/lib/index.d.ts`, `dist/lib/image-worker.js` | The `src/index.ts` barrel and image worker; runtime dependencies resolve from the consumer's `node_modules`.                                                                             |

Image decoding, compression, and screenshot transforms run in a cancellable worker thread. Jimp handles resizing and encoding; `@jsquash/jpeg` and `@jsquash/webp` decode JPEG and WebP with WASM binaries from their installed packages. Image jobs run one at a time to bound concurrent decode memory.

The library entry is terminal-independent by contract: it must never reach `src/ui/**` or a ui-only dependency, so a host without a TTY (a server, an editor extension, a test harness) can import it. `pnpm build` enforces that contract:

- **ui-only dependency ban** — the `ban-ui-only-deps` plugin in `tsup.config.ts` fails the build when a bundle-reachable module imports one of the ui-only packages (`ink`, `react`, `chalk`, `ansi-escapes`, …) or a path inside `src/ui`. The list is declared once in `tsup.config.ts` and re-derived from the actual import sites by `tests/build-guards.test.ts`, which fails if the two drift apart.
- **`react` is banned, `react-dom` never appears** — the barrel does not re-export `src/ui/**`, so `react` is reached exclusively from the terminal layer; `react-dom` is imported only by the standalone browser bundle (`src/remote/browser`, built separately via `pnpm build:browser`), which is not part of the library graph.
- **Ambiguous export scan** — once the bundle is written, the build runs the TypeScript ambiguous-export check (`TS2308`) over the library graph. A name exported by two `export *` sources is dropped by the bundler without any warning; the scan turns that into a build failure instead of a quietly smaller public API.

In a long-lived host, use `createAgentSession()` and its explicit lifecycle rather than process entry points. `recover` owns CLI crash logging and process exit; print/RPC runners own their stdio and signal handling. SDK import and session operations do not install those process-level handlers.

## Terminal Rendering Tests

`tests/helpers/virtual-terminal.ts` connects real Ink input/output streams to `@xterm/headless`. The Unicode 11 addon matches VS Code's default terminal width policy. Output bytes go directly to the emulator, and write callbacks complete after parsing; await `waitUntilRenderFlush()` for Ink renders or the fixture's `flush()` for direct writes before inspecting the buffer.

Run `pnpm exec vitest run tests/ui-cursor.test.ts tests/ui-terminal-resize.test.ts tests/terminal-output.test.ts tests/ui-rendering.test.ts` to check terminal cells, CJK and emoji widths, combining characters, cursor placement, ANSI colors, fragmented UTF-8 output, native scrollback anchors, resize redraws, and table layouts. The Apple Terminal resize fixture preserves rows below the caret when shrinking height, matching its behavior rather than xterm's deletion of those rows. These tests exercise the primary screen without mouse capture. The emulator does not validate font rendering, pixel appearance, native selection, or OS clipboard behavior; those still need testing in the target terminal. Unicode width policies, especially for complex emoji sequences, can differ between terminals.

Runtime text measurement stays on `string-width`, which already uses `get-east-asian-width` and handles ANSI stripping and grapheme clusters. The xterm packages are development dependencies.

## Live resources, settings and shell preferences

`/reload` updates Yukino's existing resources in place. It disposes old project extensions and MCP ownership, checks changed executable resources for project trust, reloads local extension dependencies, rebuilds resource commands, and reports MCP connection errors. Session history, model selection, permission mode, costs and queues remain attached to the current runtime; background work must finish first. If project initialization fails, project commands, skills and hooks are removed and safe user resources remain available. Custom keybindings, resource packages and fullscreen mode are separate capabilities.

`/settings` shows effective values and their default/user/project/override source. Changes apply immediately to the session. Ctrl+S enables saving subsequent preference changes to the user configuration selected by `--config` (otherwise `~/.yukino/config.yaml`); provider credentials and unrelated YAML keys are preserved. Model/thinking choices use the existing session state. A project value can still take precedence in a new session; the active session keeps its explicit overrides. Showing thinking controls rendering without deleting model history. Tool presentation and inline declaration budgets change model visibility; allowlists, exclusions, MCP exposure, permissions and hooks continue to apply. Control tools that cannot execute inside CodeMode remain directly callable in `only` mode. Explicit user shell commands and host resource controls remain usable.

Skills are discovered in user directories and `.agents/skills` from the nearest Git root down to the launch directory. Local names override ancestors; a nested repository or worktree `.git` file stops traversal. Without a repository, only the launch directory is scanned. Ancestor skills are included in project trust fingerprints; changed project skill bodies become available after an approved `/reload`. Skill installation keeps this trust policy. This does not add `disable-model-invocation`.

Instructions use the first readable file in each directory, in this order: `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`. An empty override also suppresses that directory's other candidates. User instructions load first, followed by Git-root-to-current-directory instructions; a child override does not erase ancestor instructions. Directory-level `SYSTEM.md` overrides are not implemented.

`shellPath` and `shellCommandPrefix` apply to the built-in Bash tool and `!`/`!!` in TUI, SDK, RPC and remote mode. A shell path is passed as one executable argument, including inside native sandboxes; on Windows use a Bash-compatible executable such as Git Bash, rather than PowerShell. The prefix and requested command form one shell process, so exported variables/functions are shared, the complete command participates in model/SDK permission checks and hooks, and cancellation terminates initialization too. PowerShell and custom shell tools retain their own configuration.

The SDK exposes `getSettings()`, `setSettings(patch, {persist})`, `reloadResources()`, `getAvailableModels()`, `cycleModel(direction)`, `cycleThinkingLevel(direction)`, `setAutoCompaction(enabled)`, `setAutoRetry(enabled)` and `abortRetry()`. `configPath` selects a file for initial loading, reload and preference persistence. Available models are configured provider/model entries, with credentials omitted; this does not fetch a remote catalog. Retry cancellation returns whether a wait was pending and preserves queued inputs. Resource/settings mutations require an idle foreground session; automatic retry/compaction toggles and retry cancellation can operate during a run. Existing queue mode controls share these settings.

RPC equivalents are `get_settings`, `set_settings {values, persist?}`, `reload`, `get_available_models`, `cycle_model {direction?:1|-1}`, `cycle_thinking {direction?:1|-1}`, `set_auto_compaction {enabled}`, `set_auto_retry {enabled}` and `abort_retry`. In remote chat, `/settings` prints safe effective preferences and `/settings <JSON patch>` applies a session override; `/reload` and `/retry` use the same runtime services.
