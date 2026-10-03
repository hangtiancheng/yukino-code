import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync as createTempDir,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, it, expect } from "vitest";

import { loadInstructions } from "@/memory/instructions.js";

const tempDirs = new Set<string>();

function mkdtempSync(prefix: string): string {
  const directory = createTempDir(prefix);
  tempDirs.add(directory);
  return directory;
}

afterEach(() => {
  for (const directory of tempDirs) {
    rmSync(directory, { recursive: true, force: true });
  }
  tempDirs.clear();
});

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
