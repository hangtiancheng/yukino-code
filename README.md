<p align="center">
  <img src="./assets/favicon.svg" width="300" alt="Yukino" />
</p>

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
providers:
  - name: anthropic
    protocol: anthropic
    base_url: https://api.anthropic.com
    model: claude-sonnet-4
    # api_key defaults to $ANTHROPIC_API_KEY
```

See the [full configuration reference](./apps/yukino/README.md#configuration) for MCP servers, hooks, sandboxing and all provider fields.

## Repository Layout

This is a pnpm monorepo (workspace `apps/*`):

| Package                                    | Description                                                      |
| ------------------------------------------ | ---------------------------------------------------------------- |
| [`@yukino.js/yukino`](./apps/yukino)       | The terminal AI coding agent (Node.js)                           |
| [`@yukino.js/mcp`](./apps/mcp)             | Official Yukino MCP tools collection — semantic doc search (RAG) |
| [`@yukino.js/glob-wasm`](./apps/glob-wasm) | WebAssembly-powered glob matching and scanning                   |

## Development

```bash
pnpm install                          # pnpm 10, Node >= 20

pnpm --filter @yukino.js/yukino dev   # launch the TUI from source
pnpm build                            # build all publishable packages
```

## License

[MIT](./LICENSE) © [hangtiancheng](https://github.com/hangtiancheng)
