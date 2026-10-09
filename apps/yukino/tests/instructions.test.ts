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
import { yukinoPath } from "@/storage/paths.js";

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
  it("loads global instructions before project instructions", () => {
    const dir = makeRepo("yukino-instr-");
    writeFileSync(join(dir, "AGENTS.md"), "plain file");
    mkdirSync(yukinoPath(), { recursive: true });
    writeFileSync(yukinoPath("AGENTS.md"), "global file");
    mkdirSync(join(dir, ".yukino"));
    writeFileSync(
      join(dir, ".yukino", "AGENTS.md"),
      "obsolete hidden instructions",
    );

    const out = loadInstructions(dir);
    expect(out).toContain("plain file");
    expect(out).toContain("global file");
    expect(out).not.toContain("obsolete hidden instructions");
    expect(out.indexOf("global file")).toBeLessThan(out.indexOf("plain file"));
  });

  it("loads project instructions from the repository root to cwd", () => {
    const root = makeRepo("yukino-instr-walk-");
    const sub = join(root, "pkg", "deep");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "root instructions");
    writeFileSync(join(sub, "AGENTS.md"), "leaf instructions");

    const out = loadInstructions(sub);
    expect(out.indexOf("root instructions")).toBeLessThan(
      out.indexOf("leaf instructions"),
    );
  });
});
