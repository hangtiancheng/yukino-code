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
import { yukinoPath } from "@/storage/index.js";

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

describe("instruction file variants", () => {
  it("uses only the override in the same directory while retaining ancestors and uppercase fallback", () => {
    const root = makeRepo("yukino-instr-variants-");
    const child = join(root, "pkg");
    mkdirSync(child);
    writeFileSync(join(root, "AGENTS.MD"), "uppercase ancestor");
    writeFileSync(join(child, "AGENTS.md"), "shadowed lowercase");
    writeFileSync(join(child, "AGENTS.MD"), "shadowed uppercase");
    writeFileSync(join(child, "AGENTS.override.md"), "override body");
    writeFileSync(join(child, "SYSTEM.md"), "unsupported system override");
    const output = loadInstructions(child);
    expect(output).toContain("uppercase ancestor");
    expect(output).toContain("override body");
    expect(output).not.toContain("shadowed");
    expect(output).not.toContain("unsupported system override");
    expect(output.indexOf("uppercase ancestor")).toBeLessThan(
      output.indexOf("override body"),
    );
  });
  it("prefers lowercase to uppercase and treats an empty override as authoritative", () => {
    const root = makeRepo("yukino-instr-empty-");
    writeFileSync(join(root, "AGENTS.MD"), "uppercase loses");
    writeFileSync(join(root, "AGENTS.md"), "lowercase wins");
    expect(loadInstructions(root)).toContain("lowercase wins");
    expect(loadInstructions(root)).not.toContain("uppercase loses");
    writeFileSync(join(root, "AGENTS.override.md"), "");
    expect(loadInstructions(root)).not.toContain("lowercase wins");
    expect(loadInstructions(root)).toContain("AGENTS.override.md");
  });
  it("stops at a nested worktree .git file and does not inherit outer repository instructions", () => {
    const outer = makeRepo("yukino-instr-worktree-");
    const inner = join(outer, "worktree");
    const child = join(inner, "src");
    mkdirSync(child, { recursive: true });
    writeFileSync(join(outer, "AGENTS.md"), "outer instructions");
    writeFileSync(join(inner, ".git"), "gitdir: /unused");
    writeFileSync(join(inner, "AGENTS.MD"), "worktree instructions");
    expect(loadInstructions(child)).toContain("worktree instructions");
    expect(loadInstructions(child)).not.toContain("outer instructions");
  });
});
