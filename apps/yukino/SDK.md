# Go SDK

Yukino exposes its terminal-independent core as Go packages. The CLI uses these same implementations. No compatibility packages remain at the old `internal/...` paths. Terminal UI is private; process diagnostics are exposed by the `recover` package.

The module path is `github.com/yukino-js/yukino/yukino` and requires Go 1.26 or later. For a local checkout, add it to your host module:

```sh
go mod edit -require=github.com/yukino-js/yukino/yukino@v0.0.0
go mod edit -replace=github.com/yukino-js/yukino/yukino=/absolute/path/to/yukino-code/apps/yukino
go mod tidy
```

The local replacement works independently of a published Go module release. Import the subpackages you use; the root package documents the SDK and does not re-export aliases.

## Packages

| Packages                                                                                 | Purpose                                                                         |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `agent`, `llm`, `config`, `conversation`                                                 | Agent loop, streaming provider interface, provider configuration, message state |
| `tools`, `bootstrap`, `permissions`, `sandbox`                                           | Custom and built-in tools, CLI tool wiring, permission rules, shell isolation   |
| `session`, `history`, `file_history`, `goal`, `compact`                                  | Persistence, input provenance, file rewind, persistent goals, compaction        |
| `skills`, `subagent`, `teams`, `todo`, `workflow`                                        | Skills, background agents, teams, task tracking, scripted orchestration         |
| `mcp`, `a2a`, `remote`, `vscode`                                                         | MCP clients, A2A server, browser server, IDE integration                        |
| `memory`, `prompt`, `commands`, `images`, `plan_file`, `tool_result`                     | Memory, prompts, commands, media, plan files, output handling                   |
| `storage`, `logger`, `telemetry`, `recover`, `update`, `utils`, `version`, `frontmatter` | Supporting services                                                             |

## Streaming a conversation

See [examples/chat/main.go](examples/chat/main.go) for a complete executable:

```sh
YUKINO_MODEL=your-model OPENAI_API_KEY=your-key go run ./examples/chat
```

Construct a provider with `llm.NewClient`, a registry with `tools.NewRegistry`, and an agent with `agent.New`. Add a user message with `conversation.Manager.AddUserMessage`, then range over `Agent.Run(ctx, conv)` until its event channel closes. Reuse the conversation for subsequent turns.

`agent.StreamText`, `ThinkingText`, `ToolUseEvent`, `ToolResultEvent`, `UsageEvent`, `CompactEvent`, `ErrorEvent`, and `LoopComplete` are concrete event types suitable for a type switch. Errors arrive as `ErrorEvent`; a closed channel alone does not establish success. Cancellation uses the supplied context. Consume the channel through closure after cancellation so the run can finish emitting events. Call `Run` serially for each agent and conversation; use separate instances for independent concurrent sessions.

The minimal registry is empty. Add built-in tools with `tools.CreateDefaultToolsWithWorkDir`, or implement `tools.Tool` and call `Registry.Register`. A custom tool supplies its name, description, category, schema, and `Execute` method. Tool schemas have `name`, `description`, and `input_schema` fields. `Execute` receives the run context and must honor cancellation. See [testdata/sdk-consumer/consumer_test.go](testdata/sdk-consumer/consumer_test.go) for a complete custom tool and provider used from a separate module.

Implement `llm.Client` to use your own transport. Return an event channel and an error channel, close both when streaming finishes, and emit `llm.StreamEnd` with the provider stop reason. Concrete `llm` event values can be constructed externally. The `protocol` argument to `agent.New` must match the provider's schema protocol (`anthropic`, `openai`, or `openai-compat`).

## Permissions and lifecycle

`agent.New` does not install a permission checker, load user configuration, connect MCP servers, install signal handlers, or initialize telemetry. Hosts opt into these services explicitly. Without a checker, registered tools execute without approval. The chat example registers no tools.

For built-in coding tools, set `Agent.WorkDir` and attach a checker:

```go
runner.Checker = permissions.NewChecker(
    permissions.NewPathSandbox(workDir, true),
    permissions.NewRuleEngine(workDir),
    permissions.ModeDefault,
)
```

Handle `agent.PermissionRequestEvent` in your event loop and send an `agent.PermissionReply` on `ResponseCh`; otherwise a requested approval waits for a response or context cancellation. Use `PermAllow`, `PermDeny`, or `PermAllowAlways` according to the host's decision. Rule engines may load user/project rules from disk. Permission checking and OS shell sandboxing are separate; `bootstrap.ConfigureBashSandbox` wires the latter when needed.

The host owns cancellation and cleanup. Finish active runs before disposing their registry. Call `Registry.Dispose`, stop background tasks through their task manager, close team runtimes, and disconnect MCP servers for resources you create. A plain agent does not automatically register the full CLI suite, skills, teams, or workflows; compose those using their public packages and `bootstrap.CreateToolRegistry`.

Set `Agent.SessionID` and `TranscriptPath` to enable agent transcript persistence. Save the initial user message using `session.SaveUserMessage` and input provenance from `history.RecordInput`; restore with `session.LoadSessionForResume`, `session.RebuildFromSession`, and `conversation.Manager.AppendMessages`. File history and goals are separate opt-in services.

Storage and logger services use per-user Yukino state. Package-level telemetry is process-wide; hosts that need independently owned telemetry can use `telemetry.CreateTelemetryRuntime` and call its `Shutdown`. Neither construction nor import installs process exit handlers. `InstallRemoteTelemetrySignalHandlers` explicitly owns process shutdown and is intended for standalone CLI hosts.

## Validation

Run `go test ./...` and `make check` in `apps/yukino`. The root SDK test creates a separate consumer module with a local replacement, verifies custom provider/tool execution, session persistence and cancellation, and runs with the race detector. The build guard scans public packages as well as internal packages to keep terminal dependencies outside the SDK.

Recent TypeScript refactors are mirrored by `skills/types.go`, `telemetry/runtime.go`, `telemetry/providers.go`, and `telemetry/provider_runtime.go`. Go uses direct package imports instead of TypeScript barrels. Frontmatter parsing remains centralized in `frontmatter` rather than duplicating module-specific regular expressions. Go's static linking does not reproduce JavaScript dynamic imports; provider initialization remains explicit.

## Process crash diagnostics

The public `recover` package (Go package name `recovery`) matches the TypeScript `recover.ts` surface: `Record`, `RecordError`, `IsTerminalGone`, `RecordExit`, and `Recover`. For a standalone process, install it with `defer recovery.Recover()()`. The first call records startup and configures runtime crash output; its returned deferred handler cleans up normal exits and catches panics in the calling goroutine. A panic records a stack, emits fatal diagnostics and telemetry, sweeps exit cleanups, and exits 1. Terminal disappearance records one terminal-closed line and exits 0. Log writes are private and best effort; exit markers are idempotent. Importing the package has no installation side effects.

Go cannot install Node-style global uncaught-exception or unhandled-rejection handlers. Panics in other goroutines are copied to the crash log by `debug.SetCrashOutput` and retain Go's runtime termination behavior; they cannot run the recovered-panic cleanup path. The recorded stack for an ordinary Go error is the reporting stack because standard Go errors do not retain their original stack. Embedded hosts should use record helpers and their own lifecycle rather than installing process-exit behavior.
