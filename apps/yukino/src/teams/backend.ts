import { execFileSync, execSync } from "node:child_process";

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
 *     the teammate progress UI in real time).
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
 *
 * Caveat: the single-quote protection only holds when the result reaches a
 * shell verbatim. The tmux branch below embeds the assembled command inside
 * outer double quotes, where single quotes are literal characters and `$`,
 * backticks, `"` and `\` remain shell-active.
 */
function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_/.:=-]+$/.test(arg)) {
    return arg;
  }
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Joins the command and its arguments into a single shell string, quoting each token via shellQuote (see its caveat re: outer quoting layers). */
function buildShellCommand(config: SpawnConfig): string {
  return [config.command, ...config.args].map(shellQuote).join(" ");
}

function cancelTmuxSession(sessionName: string): void {
  try {
    execSync(`tmux kill-session -t "${sessionName}"`, {
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    log.error({ err }, "teams operation failed");
    // Session may have already exited; ignore.
  }
}

/** Rebuilds the stable cancellation handle available for a restored tmux member. */
export function restoreTeammateCancel(
  mode: TeamMode,
  paneId?: string,
): (() => void) | undefined {
  if (mode !== "tmux" || !paneId) {
    return undefined;
  }
  return () => {
    cancelTmuxSession(paneId);
  };
}

export interface SpawnConfig {
  mode: Exclude<TeamMode, "in-process">;
  command: string;
  args: string[];
  cwd: string;
  paneId?: string;
}

export function isTeammateAlive(mode: TeamMode, paneId?: string): boolean {
  if (mode !== "tmux" || !paneId) {
    return false;
  }
  try {
    execFileSync("tmux", ["has-session", "-t", paneId], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

export function spawnTeammate(config: SpawnConfig): {
  cancel: () => void;
  paneId?: string;
} {
  switch (config.mode) {
    case "tmux": {
      const sessionName = config.paneId ?? `yukino-${Date.now().toString(36)}`;
      const cmd = buildShellCommand(config);
      execSync(`tmux new-session -d -s "${sessionName}" -n teammate "${cmd}"`, {
        cwd: config.cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      return {
        cancel: () => {
          cancelTmuxSession(sessionName);
        },
        paneId: sessionName,
      };
    }

    case "iterm": {
      const cmd = buildShellCommand(config);
      const writeText = `cd ${shellQuote(config.cwd)} && ${cmd}`;
      const script = [
        "on run argv",
        "  set commandText to item 1 of argv",
        '  tell application "iTerm2"',
        "    tell current window",
        "      create tab with default profile",
        "      tell current session to write text commandText",
        "    end tell",
        "  end tell",
        "end run",
      ].join("\n");
      execFileSync("osascript", ["-e", script, writeText], {
        cwd: config.cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
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
