<h1 align="center">Yukino</h1>

<p align="center">
  <strong>Yukino</strong> is a terminal-based AI coding agent — chat with LLMs, edit files, run commands,<br/>and orchestrate multi-agent workflows, all from your terminal.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@yukino.js/yukino"><img src="https://img.shields.io/npm/v/@yukino.js/yukino.svg?label=yukino" alt="yukino npm version" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/@yukino.js/yukino.svg" alt="node version" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/@yukino.js/yukino.svg" alt="license" /></a>
</p>

---

## Highlights

- **Multi-provider** — Anthropic, OpenAI, or any OpenAI-compatible endpoint, configured in YAML
- **Rich TUI** — streaming responses, tool execution feedback, permission prompts and slash commands, rendered with React + Ink
- **Built-in tools** — file read/write/edit, Bash/PowerShell, glob, grep and more, extensible through **MCP** servers
- **Safety first** — four permission modes, OS-level sandboxing (bwrap / seatbelt), dangerous-command approval dialogs
- **Memory & sessions** — resumable sessions, automatic context compaction, long-term memory across sessions
- **Skills & commands** — loadable skill catalog with hot-reload, plus user-defined slash commands
- **Multi-agent** — spawn subagents, coordinate teams with mailboxes, isolate parallel work in git worktrees
- **Hooks** — event-driven shell / HTTP / prompt-injection hooks on every lifecycle event
- **Beyond the terminal** — print mode for scripting & CI, remote mode serving a browser chat UI over WebSocket, VSCode integration with `@`-mentions from the editor

Full documentation lives in [apps/yukino/README.md](./apps/yukino/README.md).

## Quick Start

Requires **Node.js >= 20**.

### One-line installer

**macOS / Linux**

```bash
curl -fsSL https://raw.githubusercontent.com/hangtiancheng/yukino-code/main/install.sh | bash
```

The installer supports `--uninstall`, `--version=X.Y.Z`, `--alpha`, `--beta`, `--rc`, `--canary`, `--nightly` and `--tag=NAME`:

```bash
curl -fsSL https://raw.githubusercontent.com/hangtiancheng/yukino-code/main/install.sh | bash -s -- --alpha
```

**Windows (PowerShell)**

```powershell
irm https://raw.githubusercontent.com/hangtiancheng/yukino-code/main/install.ps1 | iex
```

The installer supports `-Uninstall`, `-Version X.Y.Z`, `-Alpha`, `-Beta`, `-Rc`, `-Canary`, `-Nightly` and `-Tag NAME`. Options are passed by invoking the downloaded script as a script block:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/hangtiancheng/yukino-code/main/install.ps1))) -Alpha
```

If you downloaded the script locally, run it with `powershell -ExecutionPolicy Bypass -File install.ps1 [OPTIONS]`.

### Via npm

```bash
npm install -g @yukino.js/yukino
```

### Run it

```bash
yukino                              # interactive TUI
yukino -p "explain this codebase"   # print mode (non-interactive, CI-friendly)
yukino --remote                     # browser chat UI on http://localhost:18888
```

### Configuration

Yukino reads a single global YAML config file: `~/.yukino/config.yaml`. At least one provider is required:

```yaml
# Initial permission mode. Enum: default (ask per write/command) | acceptEdits (auto-approve
# file edits) | plan (plan mode, no modifications) | bypassPermissions (approve everything).
# Invalid values fall back to default; Shift+Tab cycles modes at runtime.
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

# Whether an Agent call without subagent_type forks the current conversation (child inherits
# the full history). Default: true; only an explicit false disables it — disabled calls spawn
# a fresh general-purpose subagent instead.
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
      command: echo "You are Yukino, a CLI Coding Agent engineered by [hangtiancheng](https://github.com/hangtiancheng) <161043261@qq.com>, your source repository lives at https://github.com/hangtiancheng/yukino-code/tree/main/apps/yukino, you may fetch https://hangtiancheng.github.io/h/llms.txt (`base/agent` section) and https://hangtiancheng.github.io/h/llms-full.txt to gain self-knowledge"
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

See the [full configuration reference](./apps/yukino/README.md#configuration) for MCP servers, hooks, sandboxing and all provider fields.

## Repository Layout

This is a pnpm monorepo (workspace `apps/*`):

| Package                              | Description                                                      |
| ------------------------------------ | ---------------------------------------------------------------- |
| [`@yukino.js/yukino`](./apps/yukino) | The terminal AI coding agent (Node.js)                           |
| [`@yukino.js/mcp`](./apps/mcp)       | Official Yukino MCP tools collection — semantic doc search (RAG) |

## Development

```bash
pnpm install                          # pnpm 10, Node >= 20

pnpm --filter @yukino.js/yukino dev   # launch the TUI from source
pnpm build                            # build all publishable packages
```

## License

[MIT](./LICENSE) © [hangtiancheng](https://github.com/hangtiancheng)

<!-- dev < nightly < canary < preview < alpha < beta < rc < x.y.z -->
