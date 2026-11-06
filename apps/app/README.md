# Yukino Desktop

An Electron workspace built on `@yukino.js/yukino`.

```sh
pnpm install
pnpm dev
```

The header provides project selection, the command center, the Agent workbench, settings, and the code workspace; the session sidebar manages sessions only. Add a provider in settings on first launch. `~/.yukino/config.yaml` supports MCP, hooks, memory, and sandbox configuration.

- Sessions: native shell via `!` / `!!`, automatic wake-up when background work finishes, cross-project history, session restore, streaming output, reasoning traces, permissions, questions, follow-up requirements during a run, and stop.
- Workbench: goals and token budgets, task dependencies, agent and team progress, background output and cancellation, workflow phases and resume, tool search, skills, MCP, memory, sandbox, and checkpoint restore.
- Interaction: command center, attachments, reply copying, a light sage-green theme in light and dark modes, and navigation for narrow windows.
- Editor: Monaco, file tree, Git changes, live refresh, diff comparison, drafts, conflict detection, and atomic saves.
- Shortcuts: `⌘/Ctrl K` command center, `⌘/Ctrl B` session sidebar, `⌘/Ctrl J` editor, `⌘/Ctrl N` new session, `⌘/Ctrl ,` settings, `⌘/Ctrl S` save.

Drafts survive editor closure; unsaved content is handled before switching projects, closing files, or quitting. Text files are limited to 2 MB, and binary files or files outside the project are never edited. Change comparisons use the content before the current edit or Git HEAD as the baseline.

The app builds on Base UI, cmdk, TanStack Query / Virtual, Monaco, Streamdown, React Resizable Panels, Lucide, and Sonner. Agent execution, permissions, teams, workflows, and session persistence use Yukino's native capabilities.

```sh
pnpm happy:fix
pnpm test:ui
pnpm build
pnpm exec tsx tests/electron-smoke.ts
```

Unavailable projects are validated for path and permissions before startup; the target directory is verified before restoring history, preserving the current session. Initialization errors show concise recovery guidance, with paths and technical details available on demand. Permissions, protocols, sandbox mode, restore scope, and theme all use shadcn / Base UI Select; the workbench uses keyboard-navigable Tabs, and the command center uses shadcn Command / cmdk.

UI tests use a mock Agent; Electron tests use temporary projects and an isolated application data directory without sending model requests. macOS uses the locally installed Chrome by default; other platforms can run `pnpm exec playwright install chromium` or specify a browser through `CHROME_PATH`.
