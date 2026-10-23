// Library entry: flat re-export of every terminal-independent workspace
// package of the yukino monorepo (`export * from "@yukino.js/agent"`).
// The CLI entry (bin) is dist/main.js; nothing here may import from
// @yukino.js/ui or any ui-only dependency (ink, chalk, ...). That is enforced
// at build time by the ban-ui-only-deps rolldown plugin in
// tsdown.config.ts: reaching one of them fails the build. react is in that set —
// nothing outside the terminal layer may use it; react-dom is imported only by
// the standalone browser bundle (packages/remote-browser), outside this graph.

export * from "@yukino.js/a2a";
export * from "@yukino.js/acp";
export * from "@yukino.js/agent";
export * from "@yukino.js/bootstrap";
export * from "@yukino.js/commands";
export * from "@yukino.js/compact";
export * from "@yukino.js/config";
export * from "@yukino.js/conversation";
export * from "@yukino.js/feedback";
export * from "@yukino.js/file-history";
export * from "@yukino.js/goal";
export * from "@yukino.js/history";
export * from "@yukino.js/hooks";
export * from "@yukino.js/images";
export * from "@yukino.js/llm";
export * from "@yukino.js/logger";
export * from "@yukino.js/lsp";
export * from "@yukino.js/model-context-protocol";
export * from "@yukino.js/memory";
export * from "@yukino.js/permissions";
export * from "@yukino.js/plan-file";
export * from "@yukino.js/prompt";
export * from "@yukino.js/remote";
export * from "@yukino.js/sandbox";
export * from "@yukino.js/session";
export * from "@yukino.js/skills";
export * from "@yukino.js/storage";
export * from "@yukino.js/subagent";
export * from "@yukino.js/teams";
export * from "@yukino.js/telemetry";
export * from "@yukino.js/theme";
export * from "@yukino.js/todo";
export * from "@yukino.js/tool-result";
export * from "@yukino.js/tools";
export * from "@yukino.js/update";
export * from "@yukino.js/utils";
export * from "@yukino.js/vscode";
export * from "@yukino.js/workflow";
export * from "@yukino.js/worktree";

// Process-level headless entry points. They carry no UI, but they own process
// lifecycle — recover installs crash logging to ~/.yukino/crash.log and calls
// process.exit(), and print-mode owns signal exit codes — so prefer importing
// the workspace packages above directly in long-lived host processes. CLI
// argument parsing lives in the bin entry (src/cli.ts) and is not part of the
// library surface.
export * from "@/print-mode.js";
export * from "@/recover.js";
export * from "@yukino.js/version";
export * from "@yukino.js/websocket-security";

// Names exported by more than one package: bind each one explicitly to its
// canonical owner so the flat aggregation above stays unambiguous (TS2308).
// Consumers who need a specific package's constant should import that
// workspace package directly.
export { DEFAULT_ADDRESS, NO_PROVIDER_ERROR } from "@yukino.js/a2a";
export { INVALID_SESSION_ID_ERROR } from "@yukino.js/acp";
export { CHARS_PER_TOKEN } from "@yukino.js/compact";
export {
  FRONTMATTER_BLOCK_RE,
  MILLISECONDS_PER_DAY,
} from "@yukino.js/commands";
export { SHUTDOWN_TIMEOUT_MS } from "@yukino.js/lsp";
export { AGENTS_DIR_NAME } from "@yukino.js/skills";
