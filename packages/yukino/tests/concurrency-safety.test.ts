// Concurrency safety is determined by the actual arguments of each call,
// not just the tool category.
//
// cat and rm are both Bash — the former doesn't mutate external state (like
// ReadFile) and can run concurrently, while the latter would break the
// model's intended execution order if run in parallel.
import { describe, it, expect } from "vitest";

import { isSafeCommand } from "@/permissions/index.js";
import { BashTool } from "@/tools/bash.js";

describe("Bash concurrency safety is determined per command", () => {
  const bash = new BashTool();

  it("recognized read-only commands are considered safe", () => {
    for (const command of [
      "cat a.txt",
      "wc -l f",
      "grep pattern a.txt",
      "docker ps",
    ]) {
      expect(bash.isConcurrencySafe({ command })).toBe(true);
    }
  });

  it("unrecognized read-only commands still require serialization", () => {
    for (const command of ["ls", "ls -la", "git status", "pwd"]) {
      expect(bash.isConcurrencySafe({ command })).toBe(false);
    }
  });

  it("mutating commands are not considered safe", () => {
    const unsafe = [
      "rm -rf build",
      "mv a b",
      "npm install",
      "git commit -m x",
      "echo hi > f",
      "ls | wc -l",
      "ls; rm x",
      "ls && rm x",
      "echo $(rm x)",
      "ls `rm x`",
    ];
    for (const command of unsafe) {
      expect(bash.isConcurrencySafe({ command })).toBe(false);
    }
  });

  it("missing or invalid arguments are treated as unsafe", () => {
    expect(bash.isConcurrencySafe({})).toBe(false);
    expect(bash.isConcurrencySafe({ command: null })).toBe(false);
    expect(bash.isConcurrencySafe({ command: 123 })).toBe(false);
  });

  it("uses the same allowlist as the permission layer", () => {
    // Both sides must agree, otherwise a command could be permitted by permissions
    // yet serialized as unsafe — a contradiction.
    for (const command of ["ls", "rm -rf x", "cat f", "ls | wc"]) {
      expect(bash.isConcurrencySafe({ command })).toBe(isSafeCommand(command));
    }
  });
});
