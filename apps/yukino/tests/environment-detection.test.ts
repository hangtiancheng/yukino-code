import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { closeLogger, initLogger } from "@yukino.js/logger";
import { detectEnvironment } from "@yukino.js/prompt/builder.js";

let directory: string;
let logPath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "yukino-environment-"));
  const logDir = join(directory, "logs");
  logPath = join(logDir, "environment-test.jsonl");
  initLogger({
    sessionId: "environment-test",
    mode: "remote",
    logDir,
    skipCleanup: true,
    stdout: true,
  });
});

afterEach(() => {
  closeLogger();
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

function detectQuietly(cwd: string) {
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const environment = detectEnvironment(cwd);
  closeLogger();
  expect(readFileSync(logPath, "utf-8")).toBe("");
  expect(stdout).not.toHaveBeenCalled();
  expect(stderr).not.toHaveBeenCalled();
  return environment;
}

function git(...args: string[]) {
  return execFileSync("git", args, {
    cwd: directory,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("environment Git detection", () => {
  it("accepts a non-Git working directory without remote error output", () => {
    expect(detectQuietly(directory)).toMatchObject({
      cwd: directory,
      isGitRepo: false,
      gitBranch: "",
    });
  });

  it("accepts a new repository before its first commit without error output", () => {
    git("init", "-q", "-b", "environment-test");
    expect(detectQuietly(directory).isGitRepo).toBe(true);
  });

  it("still detects the branch from a nested working directory", () => {
    git("init", "-q", "-b", "environment-test");
    git(
      "-c",
      "core.hooksPath=" + join(directory, "no-hooks"),
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=Environment Test",
      "-c",
      "user.email=environment@example.invalid",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "initial",
    );
    const cwd = join(directory, "nested workspace");
    mkdirSync(cwd);
    expect(detectQuietly(cwd)).toMatchObject({
      cwd,
      isGitRepo: true,
      gitBranch: "environment-test",
    });
  });
});
