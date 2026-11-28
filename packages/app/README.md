# Yukino Desktop

An Electron workspace built on the current `@yukino.js/yukino` SDK. See [Agent capability coverage](./AGENT-CAPABILITIES.md) for desktop controls and runtime behavior.

```sh
pnpm install
pnpm dev
```

`pnpm dev` rebuilds the workspace SDK before launching Electron so the app uses the current source.

The header provides project selection, the command center, the Agent workbench, settings, and the code workspace; the session sidebar manages sessions only. Add a provider in settings on first launch. `~/.yukino/config.yaml` supports MCP, hooks, memory, and sandbox configuration.

- Sessions support `!` / `!!` shell commands, cross-project history, archive and tag filters, streaming, reasoning traces, permissions, questions, and individually editable steering or follow-up messages.
- The Agent workbench shows active goals, tasks, agents, and workflows. It also exposes branches, per-attempt model usage and cost, tool search, skills, MCP, memory, sandbox controls, and checkpoint restore.
- Run a trusted project workflow, a script path, or inline JavaScript from Workflows. Pass JSON arguments, inspect results and logs, stop a run or one worker, and resume an interrupted run.
- The command center jumps to specific workbench pages. Attach files from the picker or paste a PNG or JPEG from the clipboard. The app follows Catppuccin Latte or Mocha in light and dark modes.
- Editor: Monaco, file tree, Git changes, live refresh, diff comparison, drafts, conflict detection, and atomic saves.
- Shortcuts: `⌘/Ctrl K` command center, `⌘/Ctrl B` session sidebar, `⌘/Ctrl J` editor, `⌘/Ctrl N` new session, `⌘/Ctrl ,` settings, `⌘/Ctrl S` save.

Drafts survive editor closure; unsaved content is handled before switching projects, closing files, or quitting. Text files are limited to 2 MB, and binary files or files outside the project are never edited. Change comparisons use the content before the current edit or Git HEAD as the baseline.

The app builds on Base UI, cmdk, TanStack Query / Virtual, Monaco, Streamdown, React Resizable Panels, Lucide, and Sonner. Agent execution, permissions, teams, workflows, and session persistence use Yukino's native capabilities.

Appearance uses the official [Catppuccin Tailwind CSS plugin](https://github.com/catppuccin/tailwindcss), with Latte for light mode and Mocha for dark mode. System mode follows live OS changes; explicit selections stay fixed. The saved appearance applies before the workspace mounts and also colors the native window, dialogs, tool states, Markdown, and Monaco. Theme changes are shared with CLI settings and only apply after saving succeeds.

```sh
pnpm happy:fix
pnpm test:ui
pnpm build
pnpm test:electron
```

Unavailable projects are validated for path and permissions before startup; the target directory is verified before restoring history, preserving the current session. Initialization errors show concise recovery guidance, with paths and technical details available on demand. Permissions, protocols, sandbox mode, restore scope, and theme all use shadcn / Base UI Select; the workbench uses keyboard-navigable Tabs, and the command center uses shadcn Command / cmdk.

UI tests use a mock Agent; Electron tests use temporary projects and an isolated application data directory without sending model requests. macOS uses the locally installed Chrome by default; other platforms can run `pnpm exec playwright install chromium` or specify a browser through `CHROME_PATH`.

App diagnostics use Pino 10. Each launch writes a private JSONL file to `logs/` inside Electron's `userData` directory; **Settings → Open logs** opens this folder. App log files older than 30 days are removed on startup. Development also mirrors logs to stderr.

Logs cover app and window lifecycle, renderer warnings/errors, preload failures, Agent runs, and IPC failures. Set `YUKINO_LOG_LEVEL=debug pnpm dev` to include successful IPC requests and their duration. The default level is `info`; standard Pino levels, including `silent`, are supported. Logs omit IPC arguments/results, prompts, file contents, and complete provider settings. Credential fields and common credential patterns in error messages are redacted. Error stacks and cause chains are preserved, and shutdown flushes buffered logs before exiting.
