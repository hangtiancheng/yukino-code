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

// Concurrency safety is determined by the actual arguments of each call,
// not just the tool category.
//
// ls and rm are both Bash — the former doesn't mutate external state (like
// ReadFile) and can run concurrently, while the latter would break the
// model's intended execution order if run in parallel.
import { describe, it, expect } from "vitest";

import { isSafeCommand } from "@/permissions/index.js";
import { BashTool } from "@/tools/bash.js";

describe("Bash concurrency safety is determined per command", () => {
  const bash = new BashTool();

  it("read-only commands are considered safe", () => {
    for (const command of ["ls", "ls -la", "cat a.txt", "git status", "wc -l f", "pwd"]) {
      expect(bash.isConcurrencySafe({ command })).toBe(true);
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
