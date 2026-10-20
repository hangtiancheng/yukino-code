# Yukino

Yukino is a terminal-based AI coding agent. It provides an interactive UI (terminal user interface) for conversing with large language models, executing code, manipulating files, and orchestrating multi-agent workflows, all from the command line.

## Overview

Yukino runs as a single CLI binary that connects to configurable LLM providers (Anthropic, OpenAI, or any OpenAI-compatible endpoint). It renders a rich terminal interface using React and Ink, giving you streaming responses, tool execution feedback, permission prompts, and slash commands in a single pane.

Beyond interactive use, Yukino supports a non-interactive print mode for scripting, a remote mode that serves a browser-based chat UI over WebSocket, an ACP (Agent Client Protocol) mode for editor integration, an A2A (Agent2Agent) server mode for agent-to-agent integration, and team coordination where one leader agent manages multiple teammates running in the same process and working in parallel.

## Features

### Core Capabilities

- Multi-provider LLM support with Anthropic (Anthropic Messages), OpenAI (OpenAI Responses), and OpenAI-compatible (OpenAI Chat Completions) protocols
- Interactive terminal UI with streaming text, thinking indicators, and tool execution display
- Built-in tool set: ReadFile, WriteFile, EditFile, Bash, PowerShell, Glob, Grep, WebFetch, LSP, ComputerUse, ToolSearch, McpCall, EnterWorktree, ExitWorktree, ExitPlanMode, Goal, the TaskCreate/TaskGet/TaskList/TaskUpdate and TodoWrite tracking tools, plus Agent, LoadSkill, InstallSkill, AskUserQuestion, SyntheticOutput, TeamCreate, SendMessage, TeamDelete, TaskOutput, and TaskStop
- MCP (Model Context Protocol) server integration for extending the tool set with external services
- Permission system with four modes: default, acceptEdits, plan (read-only), and bypassPermissions
- Sandbox support for isolated command execution (bwrap on Linux, seatbelt on macOS)
- Human-in-the-loop approval dialogs for file writes and shell commands, driven by permission mode and allow/deny rules
- Tool completion events stream as calls finish; conversation history and session logs retain the original call order
- Asynchronous text reads and batched file edits with overlap validation and preserved line endings
- Home-relative tool paths (`~` and `~/...`) resolve consistently in file tools, search, LSP, and permission checks
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
- Instructions files for persistent guidance: user-global `~/.yukino/AGENTS.md`, plus `AGENTS.md` in every directory from the git root down to the working directory; instruction files are read literally without `@include` expansion

### Skills and Commands

- Skill catalog loading from `~/.agents/skills/`, `~/.yukino/skills/`, and project `.agents/skills/`, in increasing priority
- Hot-reload support for skills edited on disk
- Recursive discovery of grouped skills, with cycle protection and discovery stopping at each declared skill root
- Inline and fork execution modes for skills
- Slash command system with built-in commands and global prompt templates from `~/.yukino/prompts/`
- Skill installation from a local path or a raw SKILL.md URL

Command templates support quoted positional arguments (`$1`, `$2`, ...), `$@`, defaults such as `${1:-main}`, and slices such as `${@:2:3}`. `$ARGUMENTS` preserves the original argument text, including quotes and spacing. Substitution runs once, so placeholder text inside an argument stays literal. A template without a placeholder appends the original arguments.

### Agent Orchestration

- Subagent spawning with built-in agent types: general-purpose, plan (read-only architect), explore (read-only code explorer)
- Team coordination with file-based mailboxes and leader/member communication
- Coordinator mode for managing multi-agent workflows
- Git worktree isolation for parallel agent tasks

### Hooks

- Event-driven hook engine supporting: session_start, session_end, turn_start, turn_end, pre_send, post_receive, pre_tool_use, post_tool_use, shutdown
- Hook actions: shell commands, HTTP requests, and prompt injection (`agent` actions are reserved for a future runner and currently fail configuration validation)
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

Both installers write a default `~/.yukino/config.yaml` if none exists, verify Node.js >= 20, and support uninstall / pinned-version / dist-tag options (see their `--help` / `-Help` output).

Update a global npm, yarn, or pnpm installation with:

```bash
yukino update
yukino update --tag=canary
yukino --version
```

The command checks npm's `latest` dist-tag by default. Use `--tag=canary` (or `--tag canary`) to check another dist-tag. If its version is newer according to SemVer, the command installs that exact version using the package manager that provides the current installation. For example, `0.0.14-canary` is newer than `0.0.13-dev`. Equal or older versions are not installed. Both one-line installers use npm, so their installations support `yukino update` too. Source checkouts must be updated from the repository.

The TUI checks npm's `latest` dist-tag for a newer release asynchronously and shows a `yukino update` hint on entry when one is available. The hint disappears after the first input submission or when a session is resumed; late check results stay hidden during the conversation. Available updates are shown again on the last line of the exit summary. Network errors do not interrupt the UI. Set `YUKINO_SKIP_VERSION_CHECK=1` to disable automatic checks; explicit `yukino update` still checks for updates.

Or run directly from the monorepo:

```bash
pnpm dev
```

## Storage

Yukino stores its configuration and runtime state under `~/.yukino`. The current directory (`cwd`) determines where tools execute and which project `/resume` opens. It does not determine the storage root. Directories are created when their features are used. On POSIX, Yukino state directories use `0700` and state files use `0600`, including existing files reopened for reading or appending and temporary files used for atomic replacement. This policy covers runtime state, configuration and memory; it does not chmod working-tree source files. State writes reject symbolic links. These mode bits do not establish a Windows ACL policy.

```text
~/.yukino/
├── config.yaml
├── AGENTS.md
├── permissions.yaml
├── prompt_history.jsonl
├── command_usage.json
├── prompts/
│   └── <command>.md
├── agents/
│   └── <agent>.md
├── skills/
│   └── <skill>/SKILL.md
├── memory/
│   ├── MEMORY.md
│   └── <memory>.md
├── projects/
│   └── <project-key>/
│       ├── permissions.yaml
│       └── memory/
│           ├── MEMORY.md
│           └── <memory>.md
├── sessions/
│   ├── <project-key>/
│   │   └── <session-id>.jsonl
│   └── artifacts/
│       └── <session-id>/
│           ├── tasks.json
│           ├── file-history/
│           │   ├── snapshots.json
│           │   ├── <file-backup>
│           │   └── <clipboard-image>.png
│           └── tool-results/
│               ├── <tool-call-id>.txt
│               └── shell-<random>.output
├── plans/
│   └── <slug>.md
├── logs/
│   └── <session-id>.jsonl
├── crash.log
├── teams/
│   └── <project-key>/<team>/
│       ├── config.json
│       ├── tasks.json
│       ├── inboxes/<member>.json
│       └── logs/<session-id>.jsonl
└── worktrees/
    └── <repository-key>/<slug>/
        └── <Git working tree>
```

### Global resources

`config.yaml` contains provider and application settings. `AGENTS.md` supplies global instructions. `permissions.yaml` supplies global permission rules; project rules are stored separately under `projects/`.

`prompts/` contains user slash-command templates, `agents/` contains agent definitions that can override built-in definitions, and `skills/` contains skills installed by `InstallSkill`. Skill discovery also reads standard `~/.agents/skills/` and project `.agents/skills/`, in this order: global standard skills, global Yukino skills, then project standard skills. Later entries override earlier names. Project `AGENTS.md` and `.mcp.json` remain ordinary project resources.

`prompt_history.jsonl` shares typed input across all projects and retains the latest 10,000 entries. Both loading and writing enforce this limit, and consecutive duplicate inputs are stored once. `command_usage.json` shares command usage counts. Neither file is split by project. `memory/` stores user memories shared across projects, while `plans/` stores plan documents; each live session tracks its active plan path. `logs/` contains main-process logs and `crash.log` records process exits and failures.

### Project namespaces and resume

A project key is the lowercase hexadecimal SHA-256 of the canonical absolute `cwd`. Canonicalization resolves symlinks, so aliases of the same directory share a namespace. Distinct directories, including subdirectories and worktree directories, have distinct namespaces. Renaming or moving a project changes its key.

`sessions/<project-key>/` contains conversation JSONL files, compaction records, and goal state. `/resume` lists sessions only from the current directory's namespace. `projects/<project-key>/memory/` stores project memories, and `projects/<project-key>/permissions.yaml` stores remembered project permission rules. Teams use the same directory-based project key under `teams/`.

For example, starting Yukino in `/workspace/repo/app` and in `/workspace/other` produces different session lists and project memories, while both use the same input history and global prompt templates.

### Session artifacts and teams

`sessions/artifacts/<session-id>/` groups data owned by one session. `tasks.json` stores the private task list and its next-ID counter. `file-history/` stores rewind snapshots, original file backups, and clipboard images. `tool-results/` stores complete tool output and shell capture files. Session IDs are generated independently of the current directory, so artifacts keep their path when the executing agent switches directories.

Session cleanup removes conversations inactive for more than 30 days together with their artifact directories. Logs older than 30 days are cleaned separately. Shell output falls back to an operating-system temporary file if session storage is unavailable.

Each `teams/<project-key>/<team>/` contains team membership and process metadata in `config.json`, the shared task board in `tasks.json`, one JSON mailbox per member in `inboxes/`, and teammate logs in `logs/`. The private session task list and the team task board use separate files.

### Git worktrees

Every Yukino-created worktree is stored at `~/.yukino/worktrees/<repository-key>/<slug>/`. The repository key uses the same SHA-256 algorithm as project keys, applied to the canonical Git repository root rather than the caller's subdirectory. Calls from different subdirectories of the same repository therefore place worktrees together. Different repositories have separate directories even when they use the same slug.

For example, a worktree named `fix-login` created from `/workspace/repo/app` is placed in `~/.yukino/worktrees/<SHA-256 of /workspace/repo>/fix-login/`, with branch `worktree/fix-login/work`. Yukino returns the absolute worktree path to the caller. Git's own worktree metadata remains in the repository's Git directory; `git worktree list` shows the registered paths.

Global configuration, prompts, agent definitions, and installed skills are shared directly with the worktree. Standard project `.agents` resources are copied into it. No project `.yukino` settings are copied. `EnterWorktree` also grants that runtime access to the returned tree; it does not change the caller's working directory. `ExitWorktree` accepts only the path and uses the runtime's recorded repository, branch, Git identity and initial HEAD. Existing trees from another runtime and trees with changed contents or commits are retained. Starting a session in the worktree uses that worktree directory's own project namespace for resume, memory, and permissions.

Yukino does not read or create a project `.yukino` directory. Existing project-local state is not automatically migrated; it must be moved to the corresponding global paths before it can be resumed.

## Configuration

Yukino reads a single global YAML configuration file:

- ~/.yukino/config.yaml

Print, remote, ACP, and A2A modes require at least one configured provider; the interactive UI instead opens the provider login form when none is configured. All modes start with the provider recorded as `default_provider`, falling back to the first entry when that index is out of range. Example config.yaml:

```yaml
# Initial permission mode. Enum: default (ask per write/command) | acceptEdits (auto-approve
# file edits) | bypassPermissions (approve everything).
# Other values fall back to default. Shift+Tab cycles only these three modes.
permission_mode: bypassPermissions

# Model providers. At least one is required.
providers:
  - name: ds-anthropic # Display name
    # Wire protocol. Enum: anthropic | openai | openai-compat. Also selects the API key
    # environment fallback: anthropic → ANTHROPIC_API_KEY, openai / openai-compat → OPENAI_API_KEY.
    protocol: anthropic
    # API endpoint. The provider identity — duplicate base_url across providers is rejected.
    base_url: https://api.deepseek.com/anthropic
    model: deepseek-flash # Model identifier
    api_key: sk-xyz # Optional; omitted falls back to the protocol's environment variable
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
    api_key: sk-xyz
    thinking: high
    context_window: 1000000
    max_output_tokens: 128000

# 0-based index of the provider selected at startup. Default: 0.
default_provider: 0

# Automatic memory master switch. Default: true. false turns off the whole pipeline:
# index injection, recall, and background extraction (consolidation runs in remote mode only).
enable_memory: false

# Coordinator mode. Default: false. true narrows the leader's toolset to pure orchestration
# (team/task management) so all actual work is delegated to teammates.
enable_coordinator_mode: false

# Default value of the Agent tool's fork parameter, independent of subagent_type.
# Default: true. Each call can explicitly set fork: true or fork: false to override it.
enable_fork: true

# User-level MCP servers. Merged with the project-level .mcp.json; on a name collision the
# user-level entry wins.
mcp_servers:
  - name: codegraph # Server name; must be unique across all MCP servers
    command: codegraph # stdio server: executable. Exactly one of command | url per server.
    args: # Command-line arguments
      - serve
      - "--mcp"
  - name: yukino-mcp # stdio
    command: pnpm
    args: ["--filter", "@yukino.js/mcp", "dev"]
    # Environment variables for the child process (stdio only; ignored for url servers).
    # Supports ${VAR}, ${VAR:-default}, $VAR; an unset variable without a default fails the
    # connection.
    env:
      API_BASE_URL: "https://yukino-js.dev"
      API_KEY: "${YUKINO_MCP_API_KEY}"
  - name: yukino-mcp-http # streamable-http
    url: "http://localhost:3300/mcp" # Remote endpoint (command and url are mutually exclusive)
    # Transport. Enum: http (streamable HTTP; the default when omitted) | sse (legacy) for url
    # servers; command servers may only use stdio (omittable).
    transport: "http"
    # HTTP request headers sent with every request (url only; ignored for stdio). Same ${VAR}
    # expansion as env.
    headers:
      Authorization: "Bearer ${YUKINO_MCP_API_KEY}"
  - name: yukino-mcp-sse # legacy sse
    url: "http://localhost:3300/sse"
    transport: "sse"
    headers:
      Authorization: "Bearer ${YUKINO_MCP_API_KEY}"

# OS-level sandbox wrapping Bash commands in isolated execution
# (seatbelt on macOS, bubblewrap on Linux; unavailable elsewhere).
sandbox:
  enabled: false # Master switch
  # With the sandbox active, non-dangerous Bash commands skip human confirmation (explicit
  # deny/ask rules still apply; Bash tool only). Default: false.
  auto_allow: false
  network_enabled: true # Whether sandboxed commands may access the network

# Event-driven hooks.
hooks:
  - id: pre-tool-use # Optional identifier; the once-slot key (falls back to the array index)
    # Trigger event. Enum: session_start | session_end | turn_start | turn_end | pre_send |
    # post_receive | pre_tool_use | post_tool_use | shutdown.
    event: pre_tool_use
    # Optional JavaScript expression; a truthy result fires the hook. Variables in scope:
    # event, tool, filePath, message, args. Expressions that fail to compile or throw are
    # logged and treated as false, so the hook is skipped.
    condition: 'event.endsWith("tool_use") && (tool.toLowerCase().includes("file") || /bash/i.test(tool))'
    action:
      # Action type. Enum: command (shell command) | prompt (inject static text) | http
      # (HTTP request) | agent (reserved; rejected by validation today).
      type: command
      # Shell command: bash on POSIX, 30s timeout, working directory = project directory,
      # with YUKINO_EVENT / YUKINO_TOOL / YUKINO_FILE_PATH injected; stdout is injected into
      # the agent as a system reminder on the next turn.
      command: echo 'You are Yukino, a CLI Coding Agent engineered by [hangtiancheng](https://github.com/hangtiancheng) <161043261@qq.com>, your source repository lives at https://github.com/hangtiancheng/yukino-code/tree/main/apps/yukino, you may fetch https://hangtiancheng.github.io/h/llms.txt (`base/yukino` section) and https://hangtiancheng.github.io/h/llms-full.txt to gain self-knowledge'
    # Whether successful output rejects the tool call (pre_tool_use only). Default: false.
    # Mutually exclusive with async.
    reject: false
    # Fire only once per session (keyed by id, or index). Default: false; a failed execution
    # releases the slot so the next matching event retries.
    once: true
    # Run in the background without blocking the main flow. Default: false; output is drained
    # as a notification on the next turn.
    async: false
    # Behavior when the action execution fails. Enum: ignore (default; log only) | fail
    # (surface the error to the agent) | reject (treat the failure as a rejection; blocks the
    # tool call on pre_tool_use).
    on_error: ignore
```

Main agents, subagents, and teammates use the same path sandbox policy: read-only tools can access paths outside the working directory without path approval. Writes outside the agent's working directory, the system temp directory, or an explicitly allowed root require approval unless an explicit allow rule applies. `bypassPermissions` disables this path sandbox; switching back restores it. Explicit deny/ask rules and an agent's own plan approval lock still apply. The OS-level Bash sandbox is separate and remains controlled by the `sandbox` configuration or the TUI's `/sandbox` command. Isolated worktree agents instead receive their own worktree write root, without the parent workspace or a shared system-temp write grant; per-command output directories remain writable. Explicit OS deny-write entries still take precedence.

Sandboxed worktree agents can stage and commit through their own Git metadata and branch directory, plus Git's shared object store. Parent and sibling working trees, indexes and branch refs remain outside those grants. New worktree branches use `worktree/<slug>/work` so ref locks stay in an independently writable directory. Each isolated agent uses a private temporary directory inside its Git metadata, exposed through `TMPDIR`, `TMP` and `TEMP`.

Shell rules check every executable segment separated by newlines, `;`, `&&`, `||`, `|`, and `&`, respecting literal quotes and escapes. Remembered shell rules retain the first two words plus `*`; a rule for one segment does not authorize later segments. Substitution, redirection, environment assignments (including Bash `+=`), wrappers and unsupported control syntax cannot use remembered prefixes for automatic approval. With applicable explicit restrictions, uninspectable syntax is conservatively denied or requires approval even in bypass mode. Permission dialogs show the scopes they will remember; tools without a stable scope offer one-time approval only. File rules canonicalize relative, home-relative and symlink paths before matching.

Sandbox configuration applies to TUI, print, Remote/ACP/A2A, and in-process teammates. Enabling it fails closed when the native backend is unavailable. `bypassPermissions` does not disable it. Relative allow/deny write paths resolve against the command's execution directory; home-relative paths use the same resolver as file tools. The policy confines Bash writes and optionally disables all network access; it does not wrap PowerShell, LSP, or MCP executables.

Provider fields:

| Field              | Required | Description                                                                                                                |
| ------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------- |
| name               | yes      | Display name for the provider                                                                                              |
| protocol           | yes      | One of: anthropic, openai, openai-compat                                                                                   |
| base_url           | yes      | API base URL                                                                                                               |
| model              | yes      | Model identifier                                                                                                           |
| api_key            | no       | API key (falls back to environment variable)                                                                               |
| thinking           | no       | Thinking level: off, minimal, low, medium, high, xhigh, max (default: `high` for every protocol).                          |
| reasoning          | no       | Explicit capability switch: `false` disables reasoning entirely; omitted leaves the provider default in place.             |
| thinking_level_map | no       | Per-level overrides mapping a logical level to a provider effort string (or `null` to disable that level).                 |
| thinking_mode      | no       | Anthropic only: `budget` (default) or `adaptive`; adaptive sends effort-based `output_config` instead of a token budget.   |
| context_window     | no       | Context window in tokens (default: 1000000; no model-name inference)                                                       |
| max_output_tokens  | no       | Output cap for the model (default: 128000, never above `context_window`). Set this for models with a smaller output limit. |

The thinking level controls reasoning depth. For `anthropic` in the default `budget` mode it maps to a thinking token budget (minimal 1024, low 2048, medium 8192, high 16384, xhigh 32768, max 65536); with `thinking_mode: adaptive` it maps to an effort-based `output_config` instead (minimal resolves to low, xhigh to high). For `openai` and `openai-compat`, off through high map to the matching provider reasoning effort; xhigh and max collapse to high unless `thinking_level_map` explicitly maps them to a provider-supported value. The budget shares `max_output_tokens` and always leaves at least 1024 answer tokens, so lower `max_output_tokens` shrinks the thinking budget instead of disabling it (below a 2048-token cap no valid budget remains and thinking falls back to disabled). Levels the model does not support are declared through `thinking_level_map` (map to a supported effort, or `null` to disable) and `reasoning: false`; an unsupported request is clamped down to the nearest available level. Use `/thinking <level>` to change it at runtime (the change is applied to the active client and saved to `~/.yukino/config.yaml`), or bare `/thinking` to open a picker of the levels the active provider supports.

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
      "args": ["-y", "@yukino.js/mcp@latest"],
      "env": { "API_KEY": "${YUKINO_MCP_API_KEY}" }
    },
    "remote": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${TOKEN}" }
    }
  }
}
```

`enabled` defaults to `true`. Set it to `false` to skip a server before expanding its environment references, spawning a process, or making a network connection. The same field is supported on user-level `mcp_servers`. Disabling a server takes effect on `/mcp reload`. Enabled project entries still connect automatically; this switch is not a project trust prompt.

Each entry takes `command`/`args`/`env` (stdio) or `url`/`headers` with `type` of `http` or `sse`. Environment references support `${VAR}`, `${VAR:-default}`, and `$VAR` in commands, arguments, environment values, URLs, and headers; an unset variable without a default prevents that server from connecting. These servers are merged with the user-level `mcp_servers`; on a name collision the user-level entry wins. At startup, a malformed `.mcp.json` is ignored (logged), while an invalid individual server entry is skipped without disabling valid siblings. During `/mcp reload`, invalid config aborts the reload so the current connections remain intact.

After editing `.mcp.json` or `config.yaml`, use `/mcp reload` in the UI to re-read both sources. The reload is a full reset: every current connection is dropped, then the freshly read list is connected from scratch.

### Language servers (LSP)

Configure installed stdio language servers in `~/.yukino/config.yaml`. Servers start lazily on the first matching query; Yukino does not install or download them. The first configured server matching the file extension is selected, with one server per working directory and configuration name.

```yaml
lsp_servers:
  - name: typescript
    command: typescript-language-server
    args: ["--stdio"]
    languages:
      .ts: typescript
      .tsx: typescriptreact
      .js: javascript
      .jsx: javascriptreact
    timeout_ms: 15000
    # Optional: env, initialization_options, settings
```

`LSP` supports definition, references, hover, document/workspace symbols, implementation, type definition, call hierarchy preparation and incoming/outgoing calls, and diagnostics. Input positions are 1-based UTF-16; returned ranges follow the [LSP specification](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/) (0-based UTF-16). File content is synchronized before queries. A push-diagnostics response with `pending: true` means no current report arrived within the bounded wait, not that the file has no errors. Servers without versioned diagnostic notifications cannot guarantee detection of delayed stale reports.

The tool requests only read-only operations and rejects server-requested workspace edits and commands. Configured executables are trusted local programs, like stdio MCP servers: they run with the user's OS privileges, outside the Bash OS sandbox. Configure only servers you trust. Queries honor Yukino's read-tool permission rules and the agent's effective permission mode. Servers are shut down at host exit, with forced process-tree cleanup if necessary.

### Tasks, TODOs, and background work

Task tracking and task execution are separate:

- Interactive terminal, Remote, and ACP sessions expose `TaskCreate`, `TaskGet`, `TaskList`, and `TaskUpdate`; non-interactive print (`-p`) and A2A sessions expose `TodoWrite`. These interfaces are mutually exclusive. Creating or restoring a team switches a non-interactive leader to shared Task tools; deleting the team restores its private TODO interface and list. Teammates always use shared Task tools. Ordinary subagents and forks inherit the parent's available interface with independent private lists.
- `TaskCreate`, `TaskGet`, `TaskList`, and `TaskUpdate` share one interface: `subject`, `description`, `taskId`, `owner`, `activeForm`, `metadata`, `addBlocks`, and `addBlockedBy`. Without a team they operate on the leader's private list; with a team they operate on the shared board, including in coordinator mode. Task creation does not launch work; assigning a shared task notifies its owner.
- `TodoWrite` atomically replaces the private checklist using the same task model, statuses, IDs, persistence, and dependency validation as the private Task tools. Include every item to retain and reuse returned IDs to preserve metadata, ownership, priority, and links. An empty list clears it; completing every item retains them. New items omit `id`; titles use `subject`. The result contains `todos` and a `progress` string. Task mutations and `TaskList` report the same `TODO completed/total` count; only completed items contribute to the numerator.
- Statuses are `pending`, `in_progress`, `completed`, `blocked`, and `cancelled`; `TaskUpdate` also accepts `deleted`. Dependencies must already exist; forward references, self-dependencies, and cycles are rejected. Starting blocked work fails atomically. Only completed dependencies unblock work; cancelled dependencies remain unresolved until explicitly removed. Metadata updates merge keys; null removes a key. Shared task claim, ownership checks, dependency changes, and status updates run under one cross-process lock. Teammates automatically claim tasks when marking them in progress, cannot take another worker's task, and cannot start a second task while one is already in progress. The leader can explicitly reassign work; stop its old worker before reassignment if it is still executing.
- Interactive/Remote/ACP/A2A private lists persist per session in `~/.yukino/sessions/artifacts/<session-id>/tasks.json`, with a stored next-ID counter so deleting or clearing items never reuses IDs on resume. Shared boards use project-scoped team storage. Corrupt or inconsistent stores fail explicitly, without migration, auto-repair, or stale-state fallback. Storage and tool schemas have changed; old task files are not supported. Print mode's private checklist lasts for that invocation. The terminal's TODO progress follows the same private list or shared board as its Task tools, including teammate updates, blocked items, and cancelled items. When every item is completed, the progress line hides after five seconds without deleting tasks or resetting IDs. Adding or reopening an unfinished item shows it again and cancels the pending hide. Switching sessions or boards starts a fresh completion countdown.
- `Agent` executes delegated work. Background Agent/Bash/PowerShell invocations return runtime task IDs, distinct from TODO IDs. `TaskOutput` inspects one of these IDs or waits once (`wait: true`, `timeout_ms: 0..60000`). It does not consume automatic completion notifications or stop a task on timeout. Prefer notifications over polling. `TaskStop` remains the explicit cancellation mechanism.

The common built-in registry is used by terminal, print, Remote/ACP/A2A, and in-process teammates. Delegation, coordinator, and per-agent tool restrictions still filter that registry.

### Worker lifecycle

`Agent` selects its role and context independently: `subagent_type` defaults to `"general-purpose"`, while `fork` defaults to `true` (or the configured `enable_fork` value). An explicit `fork` value overrides the configuration for every role.

| Parameters                           | Role            | Initial context                 |
| ------------------------------------ | --------------- | ------------------------------- |
| `subagent_type: "plan", fork: true`  | plan            | Copy of the parent conversation |
| `subagent_type: "plan", fork: false` | plan            | Fresh conversation              |
| `fork: true`                         | general-purpose | Copy of the parent conversation |
| `fork: false`                        | general-purpose | Fresh conversation              |

The same combinations work for other built-in and user-defined roles. Role tool restrictions, permissions, models, and `max_turns` apply in either context mode. `run_in_background` separately controls one-shot scheduling. For persistent teammates, `fork` seeds the initial conversation once; later assignments reuse the teammate's own history. Forking copies the conversation without sharing subsequent changes, and closes pending parent tool calls only in the copied transcript.

Ordinary subagents run once. On completion, failure, or interruption, the host waits for their owned background commands to stop and releases their scoped tool registry. Parent-owned LSP/MCP tools are borrowed, not shut down by a child. Background task records and subagent transcripts persist under `~/.yukino/sessions/artifacts/`; `TaskOutput` includes the transcript path and timestamps. Finished results remain queryable from disk after the in-memory retention limit, and delivered notifications are recorded in the leader's session. Resuming restores terminal outcomes and reports abandoned running tasks as interrupted failures. Iteration-limit and model failures preserve partial text alongside the error and transcript. Cancellation callbacks are discarded when runners settle. A fork cannot create or replace teams, or stop parent-owned work.

An explicit `run_in_background: false` overrides a predefined agent's `background: true`; when omitted, the definition supplies the default, independently of `fork`. Role files accept a UTF-8 BOM before frontmatter. Delegated agents cannot manage the main session's persistent goal.

Ordinary subagents have no default model-turn limit. Role files can set a positive `max_turns` to impose one. Fresh and inherited conversations, foreground and background execution all use the selected role's limit. Reaching a configured limit reports failure with partial output and a transcript path; it does not mark the assignment complete.

Persistent teammates become idle after each turn. They keep conversation and private checklist context for follow-up assignments, but must send findings with `SendMessage`; final text is not automatically forwarded to the leader. They exit on explicit shutdown, cancellation, failure, or loss of the leader. Exit clears live permission/cancellation references, releases owned tools, and resets unfinished owned tasks to unassigned/pending. Completed and cancelled records remain intact. Teammate task ownership is not released merely because a turn becomes idle.

The team retains at most 200 terminated member summaries; running and idle members are never evicted. Fully cleaned-up failed/stopped member names can be reused.

#### Delegated permission model

Agent definitions support `permission_mode: default | acceptEdits | plan | bypassPermissions`. Subagents and teammates use **rank-based permission composition**, with three distinct values:

- **Own permission mode** (`ownMode`): the child's stored, mutable mode. It is initialized from the agent definition's `permission_mode`, or set to `plan` when a teammate is spawned with `plan_mode_required: true`; omitted values remain unset. Leader approval can replace this value with the approved execution mode, as can automatic plan approval outside coordinator mode. Changes to the parent's mode do not rewrite it.
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

- **Permanent read-only roles:** built-in `plan` and `explore` workers always use `plan`, including follow-up assignments. Parent modes and plan approval cannot grant them execution permissions.
- **Coordinator plan approval:** a teammate required to submit a plan for leader review remains in `plan` until approved, even when the leader uses `acceptEdits` or `bypassPermissions`.

Permission composition selects a mode; tool availability, explicit permission rules, and applicable sandbox policies still govern individual operations. An effective `plan` mode blocks mutations, even through allow rules or sandbox auto-allow, except the declared plan file and internal coordination tools. `max_turns` must be a positive integer. Built-in explore uses the selected parent model unless explicitly overridden.

Teammates run only in-process and route permission requests through the main session. Requests identify the agent and working directory; remembered permission patterns apply to all agents in the project. Plan-mode definitions can use `ExitPlanMode` unless explicitly excluded by their tool restrictions; `EnterPlanMode` remains unavailable to delegated agents. One-shot planning subagents return their plans to the parent without changing its mode. In coordinator mode, plan-then-execute teammates requested with `plan_mode_required` or a plan-mode definition stay read-only until the leader reviews the plan and sends `SendMessage(type="plan_approval_response", to=teammate, request_id=requestId, approve=true/false, content=review feedback)`. Permanently read-only built-in `plan` and `explore` workers return research without entering execution approval, even when `plan_mode_required` is set. Rejected plans must be revised and resubmitted. Outside coordinator mode, submitted execution plans remain automatically approved. Approval writes the leader's current mode into the teammate's own mode (`default` when the leader remains in `plan`) and resumes execution under rank composition; it does not authorize subsequent tool calls. This stored mode remains available to later permission checks: a teammate approved under `bypassPermissions` retains that own mode when the leader later switches to `default`, `acceptEdits`, or `plan`. Before resuming execution or plan revision, the host includes queued ordinary team messages with the review feedback so scope corrections are applied in that next turn. Stopped teammates release their task ownership; restored sessions mark old runtimes inactive and reclaim unfinished work. Edited worktrees are retained for explicit integration, not deleted as part of runtime cleanup. Starting an Agent under a different team name never implicitly destroys another existing team.

Bash and PowerShell commands recognized by `isSafeCommand` can run in parallel. Unrecognized commands and file mutations share a process-wide FIFO queue keyed by canonical working directory, so agents in the same workspace cannot perform these operations simultaneously. Independent worktree directories have independent queues. Queued operations can be cancelled and recheck permissions before starting. Background commands hold their workspace slot until the tracked shell exits; moving a command to the background does not release it.

`WebFetch` cancels discarded response bodies and honors cancellation even for cached pages. Direct HTTP/HTTPS access, including project intranet endpoints, remains supported.

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

After a normal model turn ends, an active goal starts another turn. Pending user input takes priority; Plan mode, interruption, and provider failures do not trigger automatic continuation. Pause and clear controls take effect during streaming without cancelling the current request. A user-set goal is already `active`; the model's `Goal` tool can inspect it or report only `complete`/`blocked` with a reason. The TODO board's `in_progress` status does not apply to goals. Only the user can set, replace, pause, resume, or clear a goal. Completion requires evidence for the whole objective. The same blocker must be recorded on three consecutive goal turns, once per turn, before continuation stops. Resuming a blocked goal starts a fresh audit.

The optional token budget counts input, output, cache-read, and cache-creation tokens for the main conversation's model requests during the goal run, including its final response. Delegated agents, memory selection, and compaction summaries are outside this counter. An in-flight request can exceed the budget; once reported, substantive work stops. Yukino makes at most one final model request with no tools to summarize verified progress, unfinished work, and blockers. Its tokens are included in the counter. The request is not retried or continued if it fails or hits its output limit. Pending user input, Plan mode, and interruption take priority; an undelivered summary remains pending across session resume. The goal remains `budget_limited` and requires explicit replacement with a new budget. The 150-turn limit requires `/goal continue` to reset it. Active time excludes idle, paused, and process-restart intervals.

TUI, Remote/ACP/A2A, and print mode share this goal loop. `yukino -p "/goal <objective>"` creates a goal for that invocation's new session. Print mode control queries finish without a model call; invalid commands return a nonzero exit code, and stream JSON retains its final `result` event.

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
yukino -p -- "--flag-like prompt text"
```

The -p flag sends a single prompt, runs the agent loop, and prints the result to stdout (`text` by default, or one JSON line per event with `--output-format stream-json`). Print mode intentionally bypasses permission prompts, so only run it on trusted prompts. Useful for scripting and CI pipelines.

JSONL output includes incremental `stream_text` and `thinking_text`, tool lifecycle events paired by `tool_id`, cache usage, retry/compaction events, completion events, and a final `result`. SIGINT and SIGTERM cancel owned background tasks and retain exit codes 130 and 143. Put options before `--`; tokens after it are prompt data.

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

### ACP Mode (Editor Integration)

```bash
yukino --acp                 # Agent Client Protocol over stdio (cannot be combined with other flags)
yukino --acp-ws              # ACP over WebSocket, listens on 127.0.0.1:18889
yukino --acp-ws 9000         # ACP over WebSocket at a custom port (host:port also works)
yukino --acp-ws 0            # OS-assigned ephemeral port; the actual ws:// URL is printed on startup
```

Implements the Agent Client Protocol (`@agentclientprotocol/sdk`) so ACP-compatible editors can drive Yukino as an external agent. The WebSocket transport only binds loopback addresses.

### A2A Mode (Agent2Agent Server)

```bash
yukino --a2a                 # A2A server, listens on 127.0.0.1:18890
yukino --a2a 9000            # custom loopback port (host:port also works)
```

Serves Yukino as an Agent2Agent (`@a2a-js/sdk`) agent so other A2A-compatible agents and orchestrators can call it. The agent card is published at `/.well-known/agent-card.json`; JSON-RPC is served at `POST /` and HTTP+JSON/REST under `/v1/...`, on protocol version 1.0 with a v0.3 compatibility layer. Each A2A context maps to one Yukino session: text messages run the agent loop and stream `working` status updates (assistant text, thinking, tool calls, tool results), and tool permission requests surface as `input-required` status updates carrying a `yukino: permission-request` data part. Clients answer by sending a `yukino: permission-response` data part (`{ permissionId, decision: allow | deny | allowAlways }`) back on the same task. Answer one pending permission per message: when several tools await approval at once, only the first `permission-response` in a message is applied and the agent re-emits `input-required` for the rest, so respond to them one at a time. The server only binds loopback addresses.

### Slash Commands

Inside the UI, these commands are available:

| Command              | Description                                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| /login               | Configure, save, and activate an LLM provider                                                                                                                                               |
| /provider            | Switch the active provider                                                                                                                                                                  |
| /model [model]       | Switch the model of the current provider; without an argument, open the model picker                                                                                                        |
| /help [command]      | Show available commands, or details for a single command                                                                                                                                    |
| /status              | Show current session status (mode, model, provider, tokens, tools, sandbox, memories, skills, MCP, session, directory)                                                                      |
| /session             | Confirm the session is active; use /resume to list past sessions                                                                                                                            |
| /memory              | List stored memories                                                                                                                                                                        |
| /memory clear        | Clear all memories                                                                                                                                                                          |
| /skills              | List available skills                                                                                                                                                                       |
| /skills reload       | Hot-reload skills from disk                                                                                                                                                                 |
| /skill <name> [args] | Run a skill by name (shorthand for `/<name> [args]`; `/skill reload` routes to `/skills reload`)                                                                                            |
| /plan [task]         | Run the built-in read-only plan agent synchronously with the main conversation context                                                                                                      |
| /goal [args]         | Set or view a persistent goal; pause, resume, replace, complete, clear, or continue after the turn limit                                                                                    |
| /compact             | Force conversation compaction                                                                                                                                                               |
| /clear               | Reset the session and clear the terminal                                                                                                                                                    |
| /resume [id]         | List or restore a previous session                                                                                                                                                          |
| /rewind              | Open checkpoint rewind dialog                                                                                                                                                               |
| /sandbox [mode]      | Configure sandbox (auto=on+auto, manual=on+manual, off)                                                                                                                                     |
| /worktree            | List git worktrees                                                                                                                                                                          |
| /mcp                 | Show MCP server status                                                                                                                                                                      |
| /mcp reload          | Re-read MCP config; disconnect every server and reconnect the freshly read list                                                                                                             |
| /thinking [level]    | Without an argument, open a picker of the supported thinking levels; with one, set the level (off, minimal, low, medium, high, xhigh, max). The setting persists to `~/.yukino/config.yaml` |
| /review [PR or URL]  | Review a pull request in a foreground subagent; without arguments, list open PRs                                                                                                            |
| /quit                | Exit the application                                                                                                                                                                        |

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

In the interactive terminal, `/feedback [description]` runs session analysis synchronously in the built-in `general-purpose` agent with a fork of the main conversation. Select diagnostic attachments, review the prepared issues, and approve them before the host uploads attachments or files issues. Cancelling feedback stops the foreground worker.

Press ↓ on the last visual row of the input to view all teammates and background subagents, including while the foreground agent is streaming. Completion menus and prompt-history navigation take precedence. Enter opens an agent's details, Escape returns or closes the list, and the unsent draft and cursor are preserved. Teammate spawn cards scroll with the transcript like background subagent cards; current progress is available in the Agents list.

Use the mouse wheel or trackpad to scroll conversation history in the terminal's native scrollback. Drag to select text and use the terminal's copy/paste shortcuts. Up/Down navigates completion menus, visual input rows, and prompt history; Down after restoring the draft opens the Agents list. Home/End and Ctrl+A/E move to the start/end of the input line. PageUp/PageDown behavior follows the terminal's own scrollback bindings.

**Design tradeoff:** Yukino uses the terminal's primary screen, with fullscreen/alternate-screen rendering and mouse capture removed. Completed messages are appended to native scrollback, preserving normal selection, copying, pasting, and wheel/trackpad history scrolling without translating scrolling into prompt-history navigation. Yukino gives up its own conversation viewport, scrollbar, click-to-latest indicator, and conversation-navigation key bindings. Scrolling and whether new output follows the bottom are controlled by the terminal; the input and footer scroll out of view while reading older history. The live area remains responsive and shows the tail of running output; the complete assistant response is printed when it finishes. Ctrl+O reprints the current transcript with expanded/collapsed details, and resume/rewind prints the restored transcript; earlier printed lines remain terminal history. Scrollback retention, selection behavior, copy/paste shortcuts, and selection stability during live redraws depend on the terminal.

Terminal resizing redraws the live area without clearing or replaying completed messages, preserving the terminal's native reading position and scrollback anchors. Historical output keeps its printed line breaks and uses the terminal's own reflow; previously printed cards are not rebuilt or stretched to fill a wider terminal. Streaming and completed Markdown tables use grids with wrapped cells, falling back to wrapped raw Markdown when the columns cannot fit their widest characters. Printed table grids follow native history reflow when the terminal narrows. Background padding does not add extra wrapped rows when the terminal narrows. The input, status, live text, running tool cards, and newly completed messages use the current width. Resize redraws are coalesced. Apple Terminal's reflowed live rows and cleared gaps are tracked so repeated width and height changes restore the input and footer without leaving old status lines behind.

Pastes longer than 10 lines or 1,000 characters collapse to `[paste #1 +124 lines]` or `[paste #1 1234 chars]`. Clipboard images appear as `[Image #1]`. Arrow keys move across each placeholder as a unit, and Backspace/Delete remove it as a unit. Placeholders survive dialog switches; submitting restores the full text and image attachments.

Pasting an image saves it as a PNG under `~/.yukino/sessions/artifacts/<session-id>/file-history/`. Its placeholder expands to a cwd-relative `@` reference on submit and loads as an inline image block. Linux requires `wl-clipboard` (Wayland) or `xclip` (X11).

## Library Build

Besides the `yukino` CLI, the package ships a library entry for embedding Yukino in another host process.

| Entry          | Output                                     | Contents                                                                                                                                                                          |
| -------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI (`yukino`) | `dist/main.js`                             | Fully bundled, minified single file with a shebang; Node built-ins plus modules with native binaries or runtime assets (`sharp`, ink's `react-devtools-core` peer) stay external. |
| Library        | `dist/lib/index.js`, `dist/lib/index.d.ts` | The `src/index.ts` barrel; runtime dependencies stay external and resolve from the consumer's `node_modules`.                                                                     |

The library entry is terminal-independent by contract: it must never reach `src/ui/**` or a ui-only dependency, so a host without a TTY (a server, an editor extension, a test harness) can import it. `pnpm build` enforces that contract:

- **ui-only dependency ban** — the `ban-ui-only-deps` plugin in `tsup.config.ts` fails the build when a bundle-reachable module imports one of the ui-only packages (`ink`, `react`, `chalk`, `ansi-escapes`, …) or a path inside `src/ui`. The list is declared once in `tsup.config.ts` and re-derived from the actual import sites by `tests/build-guards.test.ts`, which fails if the two drift apart.
- **`react` is banned, `react-dom` never appears** — the barrel does not re-export `src/ui/**`, so `react` is reached exclusively from the terminal layer; `react-dom` is imported only by the standalone browser bundle (`src/remote/browser`, built separately via `pnpm build:browser`), which is not part of the library graph.
- **Ambiguous export scan** — once the bundle is written, the build runs the TypeScript ambiguous-export check (`TS2308`) over the library graph. A name exported by two `export *` sources is dropped by the bundler without any warning; the scan turns that into a build failure instead of a quietly smaller public API.

In a long-lived host process, prefer the composable modules (`Agent`, `ToolRegistry`, …) over the process-level entry points (`print-mode`, `recover`), which own process lifecycle — `recover` installs crash logging to `~/.yukino/crash.log` and calls `process.exit()`, and `print-mode` exits on invalid flags.

## Terminal Rendering Tests

`tests/helpers/virtual-terminal.ts` connects real Ink input/output streams to `@xterm/headless`. The Unicode 11 addon matches VS Code's default terminal width policy. Output bytes go directly to the emulator, and write callbacks complete after parsing; await `waitUntilRenderFlush()` for Ink renders or the fixture's `flush()` for direct writes before inspecting the buffer.

Run `pnpm exec vitest run tests/ui-cursor.test.ts tests/ui-terminal-resize.test.ts tests/terminal-output.test.ts tests/ui-rendering.test.ts` to check terminal cells, CJK and emoji widths, combining characters, cursor placement, ANSI colors, fragmented UTF-8 output, native scrollback anchors, resize redraws, and table layouts. The Apple Terminal resize fixture preserves rows below the caret when shrinking height, matching its behavior rather than xterm's deletion of those rows. These tests exercise the primary screen without mouse capture. The emulator does not validate font rendering, pixel appearance, native selection, or OS clipboard behavior; those still need testing in the target terminal. Unicode width policies, especially for complex emoji sequences, can differ between terminals.

Runtime text measurement stays on `string-width`, which already uses `get-east-asian-width` and handles ANSI stripping and grapheme clusters. The xterm packages are development dependencies.
