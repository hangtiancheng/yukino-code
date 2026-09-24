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

// @ts-check
/**
 * Automated E2E test runner for Yukino via tmux.
 *
 * Ported from run-e2e.sh. Drives the UI by shelling out to `tmux`, sends
 * prompts parsed from markdown spec files, and checks assertions against the
 * captured pane output. Requires Node 18+ and `tmux` on PATH.
 */
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { type } from "node:os";
import path from "node:path";

/**
 * @typedef {Object} Stats
 * @property {number} passed
 * @property {number} failed
 * @property {number} skipped
 */

/**
 * @typedef {Object} TmuxOptions
 * @property {boolean} [ignoreError] - Return "" instead of throwing on non-zero exit.
 * @property {string} [cwd] - Working directory for the tmux process.
 */

// --- Configuration (override via env, no hardcoded home paths) ---
const SESS = process.env.YUKINO_SESS ?? "yukino-test-ts";
const CWD = process.env.YUKINO_CWD ?? process.cwd();
const PROMPTS_DIR =
  process.env.YUKINO_PROMPTS_DIR ?? path.join(process.cwd(), "tests/prompts");
const RESULTS_FILE =
  process.env.YUKINO_RESULTS_FILE ?? "/tmp/yukino-ts-e2e-results.txt";
const STDERR_LOG = process.env.YUKINO_STDERR_LOG ?? "/tmp/yukino-ts-stderr.log";
// Node-based runner
const RUN_CMD = process.env.YUKINO_RUN_CMD ?? "npx tsx src/main.tsx";

/** @type {Stats} */
const stats = { passed: 0, failed: 0, skipped: 0 };

writeFileSync(RESULTS_FILE, "");

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Execute a tmux command, returning stdout.
 * @param {string[]} args
 * @param {TmuxOptions} [options]
 * @returns {string}
 */
function tmux(args, options) {
  try {
    return execFileSync("tmux", args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      cwd: options?.cwd,
    }).trimEnd();
  } catch (err) {
    console.error(err);
    if (options?.ignoreError) return "";
    throw err;
  }
}

/**
 * Send keys to the tmux session.
 * @param {string} msg
 * @param {boolean} [enter=true] - Append an Enter keypress.
 * @returns {void}
 */
function sendKeys(msg, enter = true) {
  const args = ["send-keys", "-t", SESS, msg];
  if (enter) args.push("Enter");
  tmux(args);
}

/**
 * Capture the pane content (optionally with scrollback).
 * @param {number} [scrollback=0] - Lines of scrollback (0 = visible pane only).
 * @returns {string}
 */
function capturePane(scrollback = 0) {
  const args = ["capture-pane", "-t", SESS, "-p"];
  if (scrollback > 0) {
    args.push("-S", `-${scrollback}`);
  }
  return tmux(args, { ignoreError: true });
}

/**
 * Append a timestamped line to stdout and the results file.
 * @param {string} msg
 * @returns {void}
 */
function log(msg) {
  const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
  const line = `[${ts}] ${msg}`;
  console.log(line);
  appendFileSync(RESULTS_FILE, line + "\n");
}

/**
 * Start a fresh tmux session running the UI, waiting for it to be ready.
 * @returns {Promise<boolean>}
 */
async function startSession() {
  tmux(["kill-session", "-t", SESS], { ignoreError: true });
  await sleep(1000);
  tmux(
    [
      "new-session",
      "-d",
      "-s",
      SESS,
      "-x",
      "120",
      "-y",
      "40",
      `${RUN_CMD} 2>${STDERR_LOG}`,
    ],
    {
      cwd: CWD,
    },
  );
  for (let elapsed = 0; elapsed < 15; elapsed++) {
    if (capturePane().includes("Type a message")) {
      log("Session started");
      return true;
    }
    await sleep(1000);
  }
  log("FAIL: Session did not start");
  return false;
}

/**
 * Kill the tmux session.
 * @returns {void}
 */
function stopSession() {
  tmux(["kill-session", "-t", SESS], { ignoreError: true });
}

/**
 * Send a message and wait for the output to stabilize.
 * Auto-approves permission dialogs.
 * @param {string} msg
 * @param {number} [timeout=60]
 * @returns {Promise<string>}
 */
async function sendAndWait(msg, timeout = 60) {
  sendKeys(msg, true);
  await sleep(2000);
  let elapsed = 2;
  let prev = "";
  let stable = 0;
  while (elapsed < timeout) {
    const current = capturePane(500);
    if (current.includes("Permission required")) {
      sendKeys("a", false);
      await sleep(1000);
      prev = "";
      stable = 0;
      elapsed += 1;
      continue;
    }
    if (current.includes("Type a message")) {
      if (current === prev) {
        stable++;
        if (stable >= 2) return current;
      } else {
        stable = 0;
      }
    }
    prev = current;
    await sleep(2000);
    elapsed += 2;
  }
  return capturePane(500);
}

/**
 * Check an assertion against the captured output.
 * @param {string} output
 * @param {string} assertion - e.g. "CONTAINS: foo", "FILE_CONTENT: /p contains \"x\""
 * @returns {boolean}
 */
function checkAssertion(output, assertion) {
  const colonIdx = assertion.indexOf(":");
  const type = colonIdx === -1 ? assertion : assertion.slice(0, colonIdx);
  const value =
    colonIdx === -1 ? "" : assertion.slice(colonIdx + 1).replace(/^ /, "");
  switch (type) {
    case "CONTAINS":
      return output.includes(value);
    case "CONTAINS_ANY": {
      const lower = output.toLowerCase();
      return value.split("|").some((v) => lower.includes(v.toLowerCase()));
    }
    case "CONTAINS_CI":
      return output.toLowerCase().includes(value.toLowerCase());
    case "NOT_CONTAINS": {
      const lower = output.toLowerCase();
      return !value.split("|").some((v) => lower.includes(v.toLowerCase()));
    }
    case "COMPLETION":
      return true;
    case "FILE_EXISTS":
      return existsSync(value);
    case "FILE_NOT_EXISTS":
      return !existsSync(value);
    case "FILE_CONTENT": {
      const m = value.match(/^(.*?) contains "(.*)"$/);
      if (!m) return false;
      try {
        return readFileSync(m[1], "utf-8").includes(m[2]);
      } catch (err) {
        console.error(err);
        return false;
      }
    }
    default:
      return true;
  }
}

/**
 * Extract all ```text blocks from a markdown spec, joined with newlines.
 * @param {string} content
 * @returns {string}
 */
function extractPrompt(/** @type {string} */ content) {
  const blocks = [...content.matchAll(/^```text\n([\s\S]*?)^```$/gm)];
  return blocks.map((m) => m[1].replace(/\n$/, "")).join("\n");
}

/**
 * Extract all ```assertions lines from a markdown spec (non-empty).
 * @param {string} content
 * @returns {string[]}
 */
function extractAssertions(/** @type {string} */ content) {
  const blocks = [...content.matchAll(/^```assertions\n([\s\S]*?)^```$/gm)];
  return blocks.flatMap((m) => m[1].split("\n")).filter((l) => l.trim() !== "");
}

/**
 * Run a single test spec file.
 * @param {string} file
 * @returns {Promise<void>}
 */
async function runTest(file) {
  const testId = path.basename(file, ".md");
  const content = readFileSync(file, "utf-8");
  const prompt = extractPrompt(content);
  const assertions = extractAssertions(content);

  const timeoutMatch = content.match(/^timeout:\s*(\d+)/m);
  let testTimeout = timeoutMatch ? parseInt(timeoutMatch[1], 10) : 90;
  if (testTimeout > 300) testTimeout = 300;

  if (!prompt) {
    log(`SKIP ${testId}: no prompt`);
    stats.skipped++;
    return;
  }

  log(`RUN  ${testId} ...`);

  const lines = prompt.split("\n");
  let output = "";

  if (lines.length <= 1) {
    output = await sendAndWait(prompt, testTimeout);
  } else {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (i < lines.length - 1) {
        sendKeys(line, true);
        if (line.startsWith("/")) {
          await sleep(5000);
        } else {
          // Wait for the LLM to finish before sending the next prompt.
          for (let waitElapsed = 0; waitElapsed < 120; waitElapsed += 3) {
            await sleep(3000);
            const waitPane = capturePane(100);
            if (waitPane.includes("Permission required")) {
              sendKeys("a", false);
              await sleep(1000);
              continue;
            }
            if (waitPane.includes("Type a message")) {
              await sleep(2000);
              break;
            }
          }
        }
      } else {
        // Last line.
        if (line === "/rewind") {
          // /rewind opens a two-phase dialog: Enter selects the last snapshot,
          // then Enter selects "Restore code and conversation".
          sendKeys(line, true);
          await sleep(3000);
          sendKeys("", true);
          await sleep(2000);
          sendKeys("", true);
          await sleep(3000);
          output = capturePane(500);
        } else {
          output = await sendAndWait(line, testTimeout);
        }
      }
    }
  }

  if (!output) {
    output = capturePane(500);
  }

  let allPass = true;
  for (const assertion of assertions) {
    if (!assertion) continue;
    if (!checkAssertion(output, assertion)) {
      log(`FAIL ${testId}: assertion failed: ${assertion}`);
      allPass = false;
      break;
    }
  }

  if (allPass) {
    log(`PASS ${testId}`);
    stats.passed++;
  } else {
    stats.failed++;
  }
}

// Testable specs (relative to PROMPTS_DIR).
const TESTABLE_TESTS = [
  // P0: Core
  "ch02_llm_streaming/T02-01_streaming.md",
  "ch03_tools/T03-01_read_file.md",
  "ch03_tools/T03-02_write_edit.md",
  "ch03_tools/T03-03_bash.md",
  "ch03_tools/T03-04_glob_grep.md",
  "ch04_agent_loop/T04-01_multi_tool_chain.md",
  "ch05_system_prompt/T05-01_identity.md",
  "ch06_permissions/T06-01_dangerous_cmd.md",
  "ch06_permissions/T06-03_plan_readonly.md",
  // MCP
  "ch07_mcp/T07-01_context7.md",
  "ch07_mcp/T07-02_playwright.md",
  // Context management
  "ch08_context_mgmt/T08-01_compact.md",
  // Memory + session
  "ch09_memory/T09-01_instructions.md",
  "ch09_memory/T09-02_session.md",
  // Slash commands
  "ch10_slash_commands/T10-01_help.md",
  "ch10_slash_commands/T10-02_status.md",
  "ch10_slash_commands/T10-04_unknown_cmd.md",
  // Skills
  "ch11_skills/T11-01_skill_list.md",
  "ch11_skills/T11-02_skill_invoke.md",
  // Hooks
  "ch12_hooks/T12-01_hook_pre_tool_use.md",
  // Sub-agents
  "ch13_subagent/T13-01_fork_mode.md",
  "ch13_subagent/T13-02_definition_mode.md",
  // Worktree
  "ch14_worktree/T14-01_create_list.md",
  // Teams
  "ch15_teams/T15-01_team_coordination.md",
  // Rewind
  "ch16_rewind/T16-01_rewind_basic.md",
];

/**
 * Main entry point.
 * @returns {Promise<void>}
 */
async function main() {
  // Clean up test artifacts from previous runs.
  for (const f of [
    "/tmp/yukino_test_write.txt",
    "/tmp/plan_readonly_test.txt",
    "/tmp/yukino-rewind-test.txt",
  ]) {
    rmSync(f, { force: true });
  }

  log(`Starting Yukino TS E2E tests (${TESTABLE_TESTS.length} tests)...`);

  for (const t of TESTABLE_TESTS) {
    const ok = await startSession();
    if (!ok) {
      log(`FAIL: could not start session for ${t}`);
      stats.failed++;
      continue;
    }
    await runTest(path.join(PROMPTS_DIR, t));
    stopSession();
    await sleep(1000);
  }

  log("");
  log("===== RESULTS =====");
  log(`Passed: ${stats.passed}`);
  log(`Failed: ${stats.failed}`);
  log(`Skipped: ${stats.skipped}`);
  log(`Total:  ${stats.passed + stats.failed + stats.skipped}`);
}

main();
