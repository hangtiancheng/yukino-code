# Yukino

Yukino is a terminal-based AI coding agent. It provides an interactive UI (terminal user interface) for conversing with large language models, executing code, manipulating files, and orchestrating multi-agent workflows, all from the command line.

## Overview

Yukino runs as a single CLI binary that connects to configurable LLM providers (Anthropic, OpenAI, or any OpenAI-compatible endpoint). It renders a rich terminal interface using React and Ink, giving you streaming responses, tool execution feedback, permission prompts, and slash commands in a single pane.

Beyond interactive use, Yukino supports a non-interactive print mode for scripting, a remote mode that serves a browser-based chat UI over WebSocket, an ACP (Agent Client Protocol) mode for editor integration, and team coordination where one leader agent manages multiple teammates (in-process, or as separate processes in tmux/iTerm panes) working in parallel.

## Features

### Core Capabilities

- Multi-provider LLM support with Anthropic (Anthropic Messages), OpenAI (OpenAI Responses), and OpenAI-compatible (OpenAI Chat Completions) protocols
- Interactive terminal UI with streaming text, thinking indicators, and tool execution display
- Built-in tool set: ReadFile, WriteFile, EditFile, Bash, PowerShell, Glob, Grep, WebFetch, ComputerUse, ToolSearch, McpCall, EnterWorktree, ExitWorktree, ExitPlanMode, the TaskCreate/TaskGet/TaskList/TaskUpdate todo tools, plus the orchestration and interaction tools: Agent, LoadSkill, InstallSkill, AskUserQuestion, SyntheticOutput, TeamCreate, SpawnTeammate, SendMessage, ListTeams, TeamDelete, and TaskStop
- MCP (Model Context Protocol) server integration for extending the tool set with external services
- Permission system with four modes: default, acceptEdits, plan (read-only), and bypassPermissions
- Sandbox support for isolated command execution: the native backend (bwrap on Linux, seatbelt on macOS) or the sandbox-runtime backend
- Human-in-the-loop approval dialogs for file writes and shell commands, driven by permission mode and allow/deny rules

### Conversation and Memory

- Session persistence with JSONL-based storage for cross-session resume
- Automatic context compaction when conversations approach the model's context window
- Long-term memory extraction and recall across sessions (disable with `enable_memory: false` in `~/.yukino/config.yaml`)
- Instructions files for persistent guidance: user-global `~/.yukino/AGENTS.md`, plus `AGENTS.md` and `.yukino/AGENTS.md` in every directory from the git root down to the working directory, with `@include` expansion

### Skills and Commands

- Skill catalog with two-tier loading: user-global (~/.agents/skills/) and project-level (.agents/skills/), where the project level wins on a name collision
- Hot-reload support for skills edited on disk
- Inline and fork execution modes for skills
- Slash command system with built-in commands and user-defined commands from two tiers: user-global (~/.yukino/commands/) and project-level (.yukino/commands/), where the project level wins on a name collision
- Skill installation from a local path or a raw SKILL.md URL

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

- Koa HTTP server with WebSocket bridge for browser-based access
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

Or run directly from the monorepo:

```bash
pnpm dev
```

## Configuration

Yukino reads a single global YAML configuration file:

- ~/.yukino/config.yaml

Print, remote, and ACP modes require at least one configured provider; the interactive UI instead opens the provider login form when none is configured. Example config.yaml:

```yaml
permission_mode: bypassPermissions
providers:
  - name: ds-anthropic
    protocol: anthropic
    base_url: https://api.deepseek.com/anthropic
    model: deepseek-flash
    api_key: sk-xyz
    thinking: high
    context_window: 1000000
    max_output_tokens: 128000
  - name: ds-openai
    protocol: openai-compat
    base_url: https://api.deepseek.com
    model: deepseek-flash
    api_key: sk-xyz
    thinking: high
    context_window: 1000000
    max_output_tokens: 128000
default_provider: 0
enable_memory: false
enable_coordinator_mode: false
enable_fork: true
mcp_servers:
  - name: codegraph
    command: codegraph
    args:
      - serve
      - "--mcp"
  - name: yukino-mcp # stdio
    command: pnpm
    args: ["--filter", "@yukino.js/mcp", "dev"]
    env:
      API_BASE_URL: "https://yukino-js.dev"
      API_KEY: "${YUKINO_MCP_API_KEY}"
  - name: yukino-mcp-http # streamable-http
    url: "http://localhost:3300/mcp"
    transport: "http"
    headers:
      Authorization: "Bearer ${YUKINO_MCP_API_KEY}"
  - name: yukino-mcp-sse # legacy sse
    url: "http://localhost:3300/sse"
    transport: "sse"
    headers:
      Authorization: "Bearer ${YUKINO_MCP_API_KEY}"
sandbox:
  enabled: false
  backend: sandbox-runtime
  auto_allow: false
  network_enabled: true
hooks:
  - id: pre-tool-use
    event: pre_tool_use
    condition: 'event.endsWith("tool_use") || tool.toLowerCase().includes("file") || /bash/i.test(tool)'
    action:
      type: command
      command: echo "You are Yukino, a CLI Coding Agent engineered by [hangtiancheng](https://github.com/hangtiancheng) <161043261@qq.com>, your source repository lives at https://github.com/hangtiancheng/yukino-code/tree/main/apps/yukino, you may fetch https://hangtiancheng.github.io/h/llms.txt (`base/agent` section) and https://hangtiancheng.github.io/h/llms-full.txt to gain self-knowledge"
    reject: false
    once: true
    async: false
    on_error: ignore
```

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

Expressions with syntax errors are rejected at startup by hook validation; expressions that throw at runtime (misspelled method names, undefined variables) are logged and treated as false, so the hook is skipped.

### Telemetry

Telemetry is disabled by default and is configured only through environment variables. Yukino does not send prompts, model output, thinking content, tool arguments, tool results, file paths, API keys, or raw session IDs. Session identifiers included in traces are hashed.

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

| Variable             | Purpose                                             |
| -------------------- | --------------------------------------------------- |
| `SENTRY_DSN`         | Sentry project DSN.                                 |
| `SENTRY_ENVIRONMENT` | Deployment environment.                             |
| `SENTRY_RELEASE`     | Release identifier; defaults to the Yukino version. |
| `SENTRY_DEBUG`       | Set to `true` to enable Sentry SDK diagnostics.     |

### Project-level MCP servers (.mcp.json)

In addition to `mcp_servers` in `config.yaml`, Yukino reads a project-level `.mcp.json` from the working directory, using the Claude Code-compatible format:

```json
{
  "mcpServers": {
    "yukino-mcp": {
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

Each entry takes `command`/`args`/`env` (stdio) or `url`/`headers` with `type` of `http` or `sse`. Environment references support `${VAR}`, `${VAR:-default}`, and `$VAR` in commands, arguments, environment values, URLs, and headers; an unset variable without a default prevents that server from connecting. These servers are merged with the user-level `mcp_servers`; on a name collision the user-level entry wins. At startup, a malformed `.mcp.json` is ignored (logged), while an invalid individual server entry is skipped without disabling valid siblings. During `/mcp reload`, invalid config aborts the reload so the current connections remain intact.

After editing `.mcp.json` or `config.yaml`, use `/mcp reload` in the UI to re-read both sources. Unchanged connections stay live, removed servers disconnect, new servers connect, and servers whose settings changed restart.

## Usage

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
```

The -p flag sends a single prompt, runs the agent loop, and prints the result to stdout (`text` by default, or one JSON line per event with `--output-format stream-json`). Print mode intentionally bypasses permission prompts, so only run it on trusted prompts. Useful for scripting and CI pipelines.

### Remote Mode (Browser UI)

```bash
yukino --remote                  # listens on 127.0.0.1:18888
yukino --remote 9000             # custom loopback port (":9000" also works)
yukino --remote 0.0.0.0:9000      # explicitly expose on all interfaces (no built-in authentication)
```

Starts a Koa HTTP server and WebSocket bridge. The bundled React frontend is served at the configured address for browser-based interaction.

### ACP Mode (Editor Integration)

```bash
yukino --acp                 # Agent Client Protocol over stdio (cannot be combined with other flags)
yukino --acp-ws              # ACP over WebSocket, listens on 127.0.0.1:18889
yukino --acp-ws 9000         # ACP over WebSocket at a custom port (host:port also works)
```

Implements the Agent Client Protocol (`@agentclientprotocol/sdk`) so ACP-compatible editors can drive Yukino as an external agent. The WebSocket transport only binds loopback addresses.

### Slash Commands

Inside the UI, these commands are available:

| Command              | Description                                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| /login               | Configure, save, and activate an LLM provider                                                                                                                                               |
| /provider            | Switch the active provider                                                                                                                                                                  |
| /help [command]      | Show available commands, or details for a single command                                                                                                                                    |
| /status              | Show current session status (model, tokens, tools, sandbox, memories, skills, MCP)                                                                                                          |
| /session             | Confirm the session is active; use /resume to list past sessions                                                                                                                            |
| /memory              | List stored memories                                                                                                                                                                        |
| /memory clear        | Clear all memories                                                                                                                                                                          |
| /skills              | List available skills                                                                                                                                                                       |
| /skills reload       | Hot-reload skills from disk                                                                                                                                                                 |
| /skill <name> [args] | Run a skill by name (shorthand for `/<name> [args]`; `/skill reload` routes to `/skills reload`)                                                                                            |
| /plan                | Enter plan mode (read-only investigation)                                                                                                                                                   |
| /compact             | Force conversation compaction                                                                                                                                                               |
| /clear               | Reset the session and clear the terminal                                                                                                                                                    |
| /resume [id]         | List or restore a previous session                                                                                                                                                          |
| /rewind              | Open checkpoint rewind dialog                                                                                                                                                               |
| /sandbox [mode]      | Configure sandbox (auto=on+auto, manual=on+manual, off)                                                                                                                                     |
| /worktree            | List git worktrees                                                                                                                                                                          |
| /mcp                 | Show MCP server status                                                                                                                                                                      |
| /mcp reload          | Re-read MCP config; reconcile unchanged, removed, new, and changed servers                                                                                                                  |
| /thinking [level]    | Without an argument, open a picker of the supported thinking levels; with one, set the level (off, minimal, low, medium, high, xhigh, max). The setting persists to `~/.yukino/config.yaml` |
| /code-review         | Open the code review form for workspace, branch-range, or commit review                                                                                                                     |
| /quit                | Exit the application                                                                                                                                                                        |

### Keyboard Shortcuts

| Key       | Action                                                                              |
| --------- | ----------------------------------------------------------------------------------- |
| Ctrl+C    | Clear input or interrupt streaming (first press), exit app (second press within 2s) |
| Ctrl+O    | Toggle full vs. truncated tool output                                               |
| Ctrl+T    | Toggle Teams dialog overlay (when not streaming)                                    |
| Ctrl+B    | Move running foreground Bash/PowerShell tasks to the background                     |
| Ctrl+V    | Paste a clipboard image (Alt+V on Windows)                                          |
| Shift+Tab | Cycle permission modes                                                              |

Pastes longer than 10 lines or 1,000 characters collapse to `[paste #1 +124 lines]` or `[paste #1 1234 chars]`. Clipboard images appear as `[Image #1]`. Arrow keys move across each placeholder as a unit, and Backspace/Delete remove it as a unit. Placeholders survive dialog switches; submitting restores the full text and image attachments.

Pasting an image saves it as a PNG under `.yukino/file-history/<session-id>/`. Its placeholder expands to a workDir-relative `@` reference on submit and loads as an inline image block. Linux requires `wl-clipboard` (Wayland) or `xclip` (X11).

## Library Build

Besides the `yukino` CLI, the package ships a library entry for embedding Yukino in another host process.

| Entry          | Output                                     | Contents                                                                                                                                                                                                           |
| -------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CLI (`yukino`) | `dist/main.js`                             | Fully bundled, minified single file with a shebang; Node built-ins plus modules with native binaries or runtime assets (`sharp`, `@anthropic-ai/sandbox-runtime`, ink's `react-devtools-core` peer) stay external. |
| Library        | `dist/lib/index.js`, `dist/lib/index.d.ts` | The `src/index.ts` barrel; runtime dependencies stay external and resolve from the consumer's `node_modules`.                                                                                                      |

The library entry is terminal-independent by contract: it must never reach `src/ui/**` or a ui-only dependency, so a host without a TTY (a server, an editor extension, a test harness) can import it. `pnpm build` enforces that contract:

- **ui-only dependency ban** — the `ban-ui-only-deps` plugin in `tsup.config.ts` fails the build when a bundle-reachable module imports one of the ui-only packages (`ink`, `react`, `chalk`, `ansi-escapes`, …) or a path inside `src/ui`. The list is declared once in `tsup.config.ts` and re-derived from the actual import sites by `tests/build-guards.test.ts`, which fails if the two drift apart.
- **`react` is banned, `react-dom` never appears** — the barrel does not re-export `src/ui/**`, so `react` is reached exclusively from the terminal layer; `react-dom` is imported only by the standalone browser bundle (`src/remote/fe`, built separately via `pnpm build:fe`), which is not part of the library graph.
- **Ambiguous export scan** — once the bundle is written, the build runs the TypeScript ambiguous-export check (`TS2308`) over the library graph. A name exported by two `export *` sources is dropped by the bundler without any warning; the scan turns that into a build failure instead of a quietly smaller public API.

In a long-lived host process, prefer the composable modules (`Agent`, `ToolRegistry`, …) over the process-level entry points (`print-mode`, `recover`, `teammate`), which own process lifecycle — `recover` installs crash logging to `.yukino/crash.log` and calls `process.exit()`, and `print-mode` exits on invalid flags.
