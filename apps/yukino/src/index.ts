/**
 * Copyright (c) 2026 hangtiancheng
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// Library entry: re-exports every terminal-independent module of
// @yukino.js/yukino, one namespace per source directory
// (`export * as Group from "./group/index.js"`; each group barrel nests its
// submodules the same way), so top-level export names cannot collide across
// groups. The CLI entry (bin) is dist/main.js; nothing here may import from
// src/ui or any ui-only dependency (ink, chalk, ...). That is enforced
// at build time by the ban-ui-only-deps esbuild plugin in
// tsup.config.ts: reaching one of them fails the build. react is in that set —
// nothing outside the terminal layer may use it; react-dom is imported only by
// the standalone browser bundle under src/remote/fe, outside this graph.

// === acp ===
export * as Acp from "./acp/index.js";

// === agent ===
export * as Agent from "./agent/index.js";

// === bootstrap ===
export * as Bootstrap from "./bootstrap/index.js";
// export * from "./bootstrap/terminal-input.js" // Exclude UI
// export * from "./bootstrap/terminal-theme.js" // Exclude UI
// export * from "./bootstrap/ui-selection.js" // Exclude UI

// === code-review ===
export * as CodeReview from "./code-review/index.js";

// === commands ===
export * as Commands from "./commands/index.js";

// === compact ===
export * as Compact from "./compact/index.js";

// === config ===
export * as Config from "./config/index.js";
// provider-login value-imports config/index.js at module scope, so nesting
// it under Config would create an evaluation cycle (TDZ on barrel import);
// it stays a sibling namespace.
export * as ProviderLogin from "./config/provider-login.js";

// === conversation ===
export * as Conversation from "./conversation/index.js";

// === file-history ===
export * as FileHistory from "./file-history/index.js";

// === history ===
export * as History from "./history/index.js";

// === hooks ===
export * as Hooks from "./hooks/index.js";

// === images ===
export * as Images from "./images/index.js";

// === llm ===
export * as LLM from "./llm/index.js";

// === logger ===
export * as Logger from "./logger/index.js";

// === mcp ===
export * as MCP from "./mcp/index.js";

// === memory ===
export * as Memory from "./memory/index.js";

// === permissions ===
export * as Permissions from "./permissions/index.js";

// === plan-file ===
export * as PlanFile from "./plan-file/index.js";

// === prompt ===
export * as Prompt from "./prompt/index.js";

// === remote ===
export * as Remote from "./remote/index.js";

// === sandbox ===
export * as Sandbox from "./sandbox/index.js";

// === session ===
export * as Session from "./session/index.js";

// === skills ===
export * as Skills from "./skills/index.js";

// === subagent ===
export * as Subagent from "./subagent/index.js";

// === teams ===
export * as Teams from "./teams/index.js";

// === telemetry ===
export * as Telemetry from "./telemetry/index.js";

// === todo ===
export * as Todo from "./todo/index.js";

// === tool-result ===
export * as ToolResult from "./tool-result/index.js";

// === tools ===
export * as Tools from "./tools/index.js";

// === utils ===
export * as Utils from "./utils/index.js";

// === vscode ===
export * as VSCode from "./vscode/index.js";

// === worktree ===
export * as Worktree from "./worktree/index.js";

// Process-level headless entry points. They carry no UI, but on failure they
// may write crash dumps or process.exit() — prefer the composable namespaces
// above (Agent, Bootstrap.ToolRegistry, ...) in long-lived host processes.
export * as PrintMode from "./print-mode.js";
export * as Recover from "./recover.js";
export * as Teammate from "./teammate.js";
export * as Version from "./version.js";
