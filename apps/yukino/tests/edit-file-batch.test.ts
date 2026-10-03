import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EditFileTool } from "@/tools/edit-file.js";
import { FileStateCache } from "@/tools/file-state-cache.js";
import { ReadFileTool } from "@/tools/read-file.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function fixture(content: string) {
  const workDir = mkdtempSync(join(tmpdir(), "yukino-batch-edit-"));
  directories.push(workDir);
  const path = join(workDir, "file.txt");
  writeFileSync(path, content);
  const context = { workDir, fileStateCache: new FileStateCache() };
  await new ReadFileTool().execute(context, { file_path: path });
  return {
    read: () => readFileSync(path, "utf-8"),
    edit: (edits: unknown) =>
      new EditFileTool().execute(context, { file_path: path, edits }),
  };
}

describe("EditFile batch replacements", () => {
  it("matches all edits against the original text even when replacements swap text", async () => {
    const { edit, read } = await fixture("alpha\nbeta\ngamma");
    const result = await edit([
      { old_string: "beta", new_string: "alpha" },
      { old_string: "alpha", new_string: "beta" },
    ]);
    expect(result.isError).toBe(false);
    expect(result.output).toContain("2 replacements");
    expect(read()).toBe("beta\nalpha\ngamma");
  });

  it.each([
    [{ old_string: "missing", new_string: "value" }],
    [{ old_string: "new", new_string: "other" }],
    [{ old_string: "alpha", new_string: "duplicate" }],
    [{ old_string: "alpha\nbeta", new_string: "overlap" }],
    [{ old_string: "beta" }],
  ])(
    "leaves the file unchanged when a later edit fails: %j",
    async (invalid) => {
      const original = "alpha\nbeta";
      const { edit, read } = await fixture(original);
      const result = await edit([
        { old_string: "alpha", new_string: "new" },
        invalid,
      ]);
      expect(result.isError).toBe(true);
      expect(read()).toBe(original);
    },
  );

  it("rejects ambiguity unless replace_all is explicitly enabled", async () => {
    const { edit, read } = await fixture("same one\nsame two\nlast");
    expect(
      (await edit([{ old_string: "same", new_string: "changed" }])).isError,
    ).toBe(true);
    expect(read()).toBe("same one\nsame two\nlast");
    expect(
      (
        await edit([
          { old_string: "same", new_string: "changed", replace_all: true },
          { old_string: "last", new_string: "" },
        ])
      ).isError,
    ).toBe(false);
    expect(read()).toBe("changed one\nchanged two\n");
  });

  it("preserves BOM, CRLF and unchanged whitespace with LF edit snippets", async () => {
    const { edit, read } = await fixture(
      "\uFEFFheader\r\nfirst\r\nsecond\r\nunchanged  \r\n",
    );
    const result = await edit([
      { old_string: "first\nsecond", new_string: "ONE\nTWO\nTHREE" },
    ]);
    expect(result.isError).toBe(false);
    expect(read()).toBe(
      "\uFEFFheader\r\nONE\r\nTWO\r\nTHREE\r\nunchanged  \r\n",
    );
  });

  it("shows distant edits as separate diff regions with correct new line numbers", async () => {
    const lines = Array.from(
      { length: 1_000 },
      (_, index) => `line-${String(index)}`,
    );
    const { edit } = await fixture(lines.join("\n"));
    const result = await edit([
      { old_string: "line-10\n", new_string: "new-10\ninserted\n" },
      { old_string: "line-900\n", new_string: "new-900\n" },
    ]);
    expect(result.isError).toBe(false);
    expect(result.output).toContain("3 additions and 2 removals");
    expect(result.output).toContain("+  902  new-900");
    expect(result.output).not.toContain("line-500");
    expect(result.output).not.toContain("truncated");
  });

  it.each([
    undefined,
    [],
    [{ old_string: "", new_string: "x" }],
    [{ old_string: "alpha", new_string: "alpha" }],
  ])("rejects empty or ineffective edits: %j", async (edits) => {
    const { edit, read } = await fixture("alpha");
    expect((await edit(edits)).isError).toBe(true);
    expect(read()).toBe("alpha");
  });
});
