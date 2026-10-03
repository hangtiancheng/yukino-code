import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect, afterEach } from "vitest";

import { isTerminalGone, record, recordError, recordExit } from "@/recover.js";

// The crash log is always written under cwd; tests chdir into a temp directory and restore afterward
const originalCwd = process.cwd();
let activeDir: string | undefined;

function enterTempDir(): string {
  activeDir = mkdtempSync(join(tmpdir(), "yukino-crash-"));
  process.chdir(activeDir);
  return activeDir;
}

afterEach(() => {
  process.chdir(originalCwd);
  if (activeDir) {
    rmSync(activeDir, { recursive: true, force: true });
    activeDir = undefined;
  }
});

describe("crash log", () => {
  it("appends records with a timestamp", () => {
    const dir = enterTempDir();

    record("start pid=1");
    try {
      throw new Error("boom");
    } catch (err) {
      recordError("uncaughtException", err);
    }

    const log = readFileSync(join(dir, ".yukino", "crash.log"), "utf8");
    expect(log).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/u);
    expect(log).toContain("start pid=1");
    expect(log).toContain("crash [uncaughtException] Error: boom");
    expect(log).toContain("recover.test.ts");
    // Append semantics: a later entry must not overwrite an earlier one
    expect(log.indexOf("start pid=1")).toBeLessThan(log.indexOf("crash ["));
  });

  // The idempotency flag is module-level; this is the only call site for recordExit in this file
  it("writes the exit marker only once", () => {
    const dir = enterTempDir();

    recordExit(0);
    recordExit(1);

    const log = readFileSync(join(dir, ".yukino", "crash.log"), "utf8");
    const marks = log.split("\n").filter((line) => line.includes("exit pid="));
    expect(marks).toHaveLength(1);
    expect(marks[0]).toContain("code=0");
  });

  it("records non-Error rejection values", () => {
    const dir = enterTempDir();

    recordError("unhandledRejection", "plain string reason");

    const log = readFileSync(join(dir, ".yukino", "crash.log"), "utf8");
    expect(log).toContain("crash [unhandledRejection] plain string reason");
  });
});

// A closed terminal (window shut, VS Code main process dying, ssh dropped) makes
// later writes fail with EIO/EPIPE. Treating those as crashes is what produced
// the `write EIO` entries in .yukino/crash.log, so the classification is tested
// against the error shapes Node actually throws.
describe("isTerminalGone", () => {
  it("recognizes the errors a vanished terminal produces", () => {
    // Shape seen in crash.log: Error: write EIO, with a numeric errno.
    const eio = Object.assign(new Error("write EIO"), {
      code: "EIO",
      syscall: "write",
      errno: -5,
    });
    expect(isTerminalGone(eio)).toBe(true);

    // A pipe reader closing produces EPIPE rather than EIO.
    expect(
      isTerminalGone(
        Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
      ),
    ).toBe(true);
  });

  it("does not classify unrelated failures as a vanished terminal", () => {
    expect(isTerminalGone(new Error("boom"))).toBe(false);
    expect(
      isTerminalGone(Object.assign(new Error("nope"), { code: "ENOENT" })),
    ).toBe(false);
    // Non-object rejections must not be mistaken for a closed terminal.
    expect(isTerminalGone(undefined)).toBe(false);
    expect(isTerminalGone(null)).toBe(false);
    expect(isTerminalGone("write EIO")).toBe(false);
  });
});

// recover() installs process-level handlers and calls process.exit(), so it is
// exercised in a child process: the real exit code and the real crash.log are
// observed, and the handlers cannot leak into the test runner.
const testsDir = dirname(fileURLToPath(import.meta.url));
const terminalScript = join(testsDir, "recover-terminal-script.ts");
const tsconfigPath = join(testsDir, "..", "tsconfig.json");
const tsxLoader = fileURLToPath(import.meta.resolve("tsx"));

function runTerminalScript(mode: string, cwd: string) {
  return spawnSync(
    process.execPath,
    ["--import", tsxLoader, terminalScript, mode],
    {
      cwd,
      encoding: "utf8",
      env: { ...process.env, TSX_TSCONFIG_PATH: tsconfigPath },
      timeout: 60_000,
    },
  );
}

describe("recover() when the terminal disappears", () => {
  it("exits 0 and records a clean shutdown for an uncaught EIO write", () => {
    const dir = mkdtempSync(join(tmpdir(), "yukino-crash-"));
    try {
      const result = runTerminalScript("uncaught", dir);

      expect(result.status).toBe(0);

      const log = readFileSync(join(dir, ".yukino", "crash.log"), "utf8");
      expect(log).toContain("terminal closed [uncaught exception] write EIO");
      // The whole point: losing the terminal must not read as a crash.
      expect(log).not.toContain("crash [");
      expect(log).toContain("code=0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 0 when stdout itself reports the vanished terminal", () => {
    const dir = mkdtempSync(join(tmpdir(), "yukino-crash-"));
    try {
      const result = runTerminalScript("stdio", dir);

      expect(result.status).toBe(0);

      const log = readFileSync(join(dir, ".yukino", "crash.log"), "utf8");
      expect(log).toContain("terminal closed [stdio] write EIO");
      expect(log).not.toContain("crash [");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Guard against the terminal-gone classification silently disabling crash
  // reporting altogether.
  it("still reports a genuine bug as a crash", () => {
    const dir = mkdtempSync(join(tmpdir(), "yukino-crash-"));
    try {
      const result = runTerminalScript("other", dir);

      expect(result.status).toBe(1);

      const log = readFileSync(join(dir, ".yukino", "crash.log"), "utf8");
      expect(log).toContain("crash [uncaught exception] Error: real bug");
      expect(log).not.toContain("terminal closed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
