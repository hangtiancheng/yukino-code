# Desktop Agent capabilities

The desktop app owns one `AgentSession` from the workspace's current Yukino SDK. Execution, queues, permissions, project trust, session storage, cost tracking, shell configuration and resource reload use that same session. The renderer receives typed JSON through preload IPC; provider credentials stay in the main process.

| Capability                                                                                                    | Desktop entry                                                                                    |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Streaming, thinking, rich tool results, MCP Apps, images and file references                                  | Conversation and composer                                                                        |
| Steering and follow-up queues, delivery modes, clearing, and single-message recall                            | Composer delivery selector and queue; Execution & usage                                          |
| Permissions, project trust, questions and plan approval                                                       | Conversation cards and approval dialogs, including during startup or while another modal is open |
| Providers, discovered models, thinking and configured-model cycling                                           | Settings; Execution & usage                                                                      |
| Code Mode off/on/only and declaration budget                                                                  | Settings → Agent preferences                                                                     |
| Thinking visibility, tool expansion, spacing and completion limit                                             | Settings → Display                                                                               |
| Session/global preferences and configuration sources                                                          | Settings; Execution & usage                                                                      |
| Unified configuration, instructions, skills, commands, hooks and MCP reload                                   | `/reload`; Settings; Execution & usage                                                           |
| `!` / `!!`, shared shell executable/prefix, cancellation and live output                                      | Composer; shell settings in the shared config                                                    |
| Session history, branches, labels, names, tags, archive, fork and clone                                       | Session sidebar; Session & branches                                                              |
| Portable JSONL/HTML export, JSONL import and diagnostics                                                      | Session & branches, using native file dialogs                                                    |
| Context compaction, auto compaction, auto retry, retry cancellation and stop scopes                           | Settings; Execution & usage                                                                      |
| Cache warming, usage, and per-attempt estimated and provider-reported cost                                    | Execution & usage                                                                                |
| Tools, inline/fork skills, skill installation and slash commands                                              | Tools & skills; composer; command center                                                         |
| MCP registration/configuration, connection, exposure rules, OAuth and resources/templates                     | MCP servers; advanced configuration accepts the SDK's MCP server schema                          |
| Goals, budgets, task dependencies and background task output/cancellation                                     | Goals & tasks                                                                                    |
| Subagents, teams and teammate cancellation                                                                    | Agents                                                                                           |
| Workflows from a trusted project, a file, or inline JavaScript; arguments, progress, results, stop and resume | Workflows; `/workflows`                                                                          |
| Memory, hooks, sandbox and project configuration                                                              | Context; Open config                                                                             |
| File checkpoints and conversation rewind                                                                      | Checkpoints                                                                                      |
| Worktree tools                                                                                                | Agent tools; `/worktree` lists worktrees                                                         |
| File tree, Git status, Monaco editing/diffs and draft conflict handling                                       | Code workspace                                                                                   |

Themes use the official [Catppuccin Tailwind CSS package](https://github.com/catppuccin/tailwindcss): Latte for light mode and Mocha for dark mode. Native system theme changes, Monaco syntax/diffs and Markdown syntax highlighting follow the selected appearance.

Print, stdio RPC, A2A server, and browser remote mode are separate Yukino hosts. The desktop uses the same session harness through the SDK.

Shell and slash commands require an idle session. Plain messages sent during a run use the selected steering/follow-up delivery. Resource reload rejects active foreground/background work rather than disposing resources beneath it. Import restores records without replaying tools, and uses the currently selected project as its execution destination.

The native main process uses `session.runtime` only for workspace/workbench integrations and `runHostOperation` for serialized native commands. Workspace baselines are captured through file-history callbacks, including writes made inside Code Mode. Background completion calls `continueRun()` without generating a user message or imposing a background-task timeout.

Validation:

```sh
pnpm --filter @yukino.js/yukino happy:fix
pnpm --filter @yukino.js/app happy:fix
pnpm --filter @yukino.js/app test:ui
pnpm --filter @yukino.js/app test:electron
```

On headless Linux, run the Electron command under `xvfb-run -a`. The native Agent smoke test uses an isolated home/profile and a loopback fixture provider. It exercises project approval, persisted Code Mode with the production tool registry, parallel Bash, file writes, settings/reload, prefixed user shell and session import/export without model-service requests.
