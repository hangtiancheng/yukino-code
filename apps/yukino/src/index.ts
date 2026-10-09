// Library entry: re-exports every terminal-independent module of
// @yukino.js/yukino, one namespace per source directory
// (`export * as Agent from "./agent/index.js"`; each group barrel nests its
// submodules the same way), so top-level export names cannot collide across
// groups. The CLI entry (bin) is dist/main.js; nothing here may import from
// src/ui or any ui-only dependency (ink, chalk, ...). That is enforced
// at build time by the ban-ui-only-deps esbuild plugin in
// tsup.config.ts: reaching one of them fails the build. react is in that set —
// nothing outside the terminal layer may use it; react-dom is imported only by
// the standalone browser bundle under src/remote/browser, outside this graph.

export * as A2a from "./a2a/index.js";
export * as Acp from "./acp/index.js";
export * as Agent from "./agent/index.js";
export * as Bootstrap from "./bootstrap/index.js";
export * as CodeReview from "./code-review/index.js";
export * as Commands from "./commands/index.js";
export * as Compact from "./compact/index.js";
export * as Config from "./config/index.js";
export * as Conversation from "./conversation/index.js";
export * as FileHistory from "./file-history/index.js";
export * as Goal from "./goal/index.js";
export * as History from "./history/index.js";
export * as Hooks from "./hooks/index.js";
export * as Images from "./images/index.js";
export * as LLM from "./llm/index.js";
export * as Logger from "./logger/index.js";
export * as LSP from "./lsp/index.js";
export * as MCP from "./mcp/index.js";
export * as Memory from "./memory/index.js";
export * as Permissions from "./permissions/index.js";
export * as PlanFile from "./plan-file/index.js";
export * as Prompt from "./prompt/index.js";
export * as Remote from "./remote/index.js";
export * as Sandbox from "./sandbox/index.js";
export * as Session from "./session/index.js";
export * as Skills from "./skills/index.js";
export * as Subagent from "./subagent/index.js";
export * as Teams from "./teams/index.js";
export * as Telemetry from "./telemetry/index.js";
export * as Todo from "./todo/index.js";
export * as ToolResult from "./tool-result/index.js";
export * as Tools from "./tools/index.js";
export * as Update from "./update/index.js";
export * as Utils from "./utils/index.js";
export * as VSCode from "./vscode/index.js";
export * as Worktree from "./worktree/index.js";

// Process-level headless entry points. They carry no UI, but they own process
// lifecycle — recover installs crash logging to ~/.yukino/crash.log and calls
// process.exit(), and print-mode exits on invalid flags — so prefer the
// composable namespaces above (Agent, Bootstrap.ToolRegistry, ...) in
// long-lived host processes.
export * as PrintMode from "./print-mode.js";
export * as Recover from "./recover.js";
export * as Version from "./version.js";
