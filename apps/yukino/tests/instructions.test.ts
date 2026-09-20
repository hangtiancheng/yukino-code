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

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { loadInstructions } from "@/memory/instructions.js";

function makeRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

describe("instruction file loading", () => {
  it(".yukino/AGENTS.md is ordered after AGENTS.md in the same directory", () => {
    const dir = makeRepo("yukino-instr-");
    writeFileSync(join(dir, "AGENTS.md"), "plain file");
    mkdirSync(join(dir, ".yukino"), { recursive: true });
    writeFileSync(join(dir, ".yukino", "AGENTS.md"), "dotdir file");

    const out = loadInstructions(dir);
    expect(out).toContain("plain file");
    expect(out).toContain("dotdir file");
    // Later entries take higher precedence
    expect(out.indexOf("plain file")).toBeLessThan(out.indexOf("dotdir file"));
  });

  it(".yukino/AGENTS.md participates in directory traversal with deeper dirs ordered later", () => {
    const root = makeRepo("yukino-instr-walk-");
    const sub = join(root, "pkg", "deep");
    mkdirSync(sub, { recursive: true });
    mkdirSync(join(root, ".yukino"), { recursive: true });
    writeFileSync(join(root, ".yukino", "AGENTS.md"), "dotdir root");
    mkdirSync(join(sub, ".yukino"), { recursive: true });
    writeFileSync(join(sub, ".yukino", "AGENTS.md"), "dotdir leaf");

    const out = loadInstructions(sub);
    expect(out.indexOf("dotdir root")).toBeLessThan(out.indexOf("dotdir leaf"));
  });
});
