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

import { execSync, spawn } from "node:child_process";

import type { TeamMode } from "./index.js";

import { createChildLogger } from "@/logger/index.js";

const log = createChildLogger({ module: "teams" });

/**
 * Auto-detect the best backend for running teammates.
 *
 * Auto-detection logic:
 *   - Windows: always **in-process**.
 *   - Otherwise: tmux/iTerm panes when the corresponding environment is
 *     detected (TMUX / ITERM_SESSION_ID), else **in-process** so progress
 *     tracking works (agent events flow in the same process and can update
 *     the Spinner Tree in real time).
 *
 * In-process teammates share the Node.js event loop but are context-isolated.
 * They communicate via the same file-based mailbox as external teammates.
 */
export function detectBackend(): TeamMode {
  if (process.platform === "win32") {
    return "in-process";
  }
  return detectBackendFromEnv();
}

/**
 * Detect available pane backend from the environment (TMUX /
 * ITERM_SESSION_ID); falls back to in-process. Called unconditionally by
 * detectBackend on non-Windows platforms.
 */
export function detectBackendFromEnv(): TeamMode {
  if (process.env.TMUX) {
    return "tmux";
  }
  // try {
  //   execSync("which tmux", { stdio: ["pipe", "pipe", "pipe"] });
  //   return "tmux";
  // } catch (err) {
  //   log.error({ err }, "teams operation failed");
  //   // tmux not found
  // }
  if (process.env.ITERM_SESSION_ID) {
    return "iterm";
  }
  return "in-process";
}

/**
 * Wraps the argument in single quotes and escapes embedded single quotes,
 * ensuring arguments containing spaces or special characters (e.g. multi-word
 * tasks like `--task find the bug`) are parsed as a single token by the shell.
 * Arguments consisting solely of alphanumerics and a small set of safe symbols
 * are left unquoted for readability.
 */
function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_/.:=-]+$/.test(arg)) {
    return arg;
  }
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Joins the command and its arguments into a single shell-executable string, applying safe escaping to each token. */
function buildShellCommand(config: SpawnConfig): string {
  return [config.command, ...config.args].map(shellQuote).join(" ");
}

export interface SpawnConfig {
  mode: TeamMode;
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

export function spawnTeammate(config: SpawnConfig): {
  cancel: () => void;
  paneId?: string;
} {
  switch (config.mode) {
    case "in-process": {
      const child = spawn(config.command, config.args, {
        cwd: config.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...config.env },
      });
      return {
        cancel: () => child.kill("SIGTERM"),
      };
    }

    case "tmux": {
      const sessionName = `yukino-${Date.now().toString(36)}`;
      const cmd = buildShellCommand(config);
      try {
        execSync(`tmux new-window -t "${sessionName}" -n teammate "${cmd}"`, {
          cwd: config.cwd,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        log.error({ err }, "teams operation failed");

        // Create a new detached session to host the teammate window when the target session does not exist

        execSync(
          `tmux new-session -d -s "${sessionName}" -n teammate "${cmd}"`,
          {
            cwd: config.cwd,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
      }
      return {
        cancel: () => {
          try {
            execSync(`tmux kill-session -t "${sessionName}"`, {
              stdio: ["pipe", "pipe", "pipe"],
            });
          } catch (err) {
            log.error({ err }, "teams operation failed");

            // Session may have already exited; ignore
          }
        },
        paneId: sessionName,
      };
    }

    case "iterm": {
      // iTerm2 (macOS): use osascript to drive AppleScript, opening a new tab to run the teammate command.
      // cd into the working directory first, then execute the teammate startup command — mirroring the tmux new-window behavior.
      const cmd = buildShellCommand(config);
      const writeText = `cd ${shellQuote(config.cwd)} && ${cmd}`;
      // Escape backslashes and double quotes for the AppleScript string literal
      const escaped = writeText.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const lines = [
        'tell application "iTerm2"',
        "  tell current window",
        "    create tab with default profile",
        `    tell current session to write text "${escaped}"`,
        "  end tell",
        "end tell",
      ];
      // Pass each line via -e wrapped in single quotes to prevent the shell from interpreting special characters in the AppleScript
      const eArgs = lines
        .map((l) => `-e '${l.replace(/'/g, `'\\''`)}'`)
        .join(" ");
      execSync(`osascript ${eArgs}`, {
        cwd: config.cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      // iTerm2 tabs are closed by the user; there is no programmatic session handle to force-kill, so cancellation is delegated to the mailbox shutdown flow
      return {
        cancel: () => {
          /* no-op: external iTerm tabs have no programmatic handle; shutdown is delivered via the mailbox */
        },
      };
    }

    default:
      throw new Error(`Unknown team mode: ${String(config.mode)}`);
  }
}
