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
  const cwd = mkdtempSync(join(tmpdir(), "yukino-batch-edit-"));
  directories.push(cwd);
  const path = join(cwd, "file.txt");
  writeFileSync(path, content);
  const context = { cwd, fileStateCache: new FileStateCache() };
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

  it.each(["\n", "\r\n"])(
    "removes injected inline carriage returns from Go edits in a %j file",
    async (ending) => {
      const { edit, read } = await fixture(
        [
          "package proxy_test",
          "",
          "import (",
          '\t"github.com/hangtiancheng/yukino.go/yukino_agent_proxy/internal/claude/bridge"',
          ")",
          "",
          "\t\t\tif err := upstream.New(p).Check(ctx); err != nil {",
          "unchanged  ",
          "",
        ].join(ending),
      );
      const result = await edit([
        {
          old_string:
            '\t"github\r.com\r/hangtiancheng\r/yukino\r.go\r/yukino\r_agent\r_proxy\r/internal\r/claude\r/bridge"',
          new_string:
            '\t"github\r.com\r/hangtiancheng\r/yukino\r.go\r/yukino\r_agent\r_proxy\r/internal\r/claude"\n\t"github\r.com\r/hangtiancheng\r/yukino\r.go\r/yukino\r_agent\r_proxy\r/internal\r/claude\r/bridge"',
        },
        {
          old_string:
            "\t\t\tif\r err\r \r:\r=\r upstream\r.New\r(p\r)\r.Check\r(ctx\r)\r;\r err\r \r!\r=\r nil\r \r{",
          new_string:
            "\t\t\tif\r err\r \r:\r=\r claude\r.Check\r(ctx\r,\r upstream\r.New\r(p\r)\r)\r;\r err\r \r!\r=\r nil\r \r{",
        },
      ]);
      expect(result.isError).toBe(false);
      expect(result.output).toContain("2 replacements");
      expect(read()).toBe(
        [
          "package proxy_test",
          "",
          "import (",
          '\t"github.com/hangtiancheng/yukino.go/yukino_agent_proxy/internal/claude"',
          '\t"github.com/hangtiancheng/yukino.go/yukino_agent_proxy/internal/claude/bridge"',
          ")",
          "",
          "\t\t\tif err := claude.Check(ctx, upstream.New(p)); err != nil {",
          "unchanged  ",
          "",
        ].join(ending),
      );
    },
  );

  it("preserves intentional inline carriage returns when the original matches", async () => {
    const { edit, read } = await fixture("before\na\rb\nafter\n");
    const result = await edit([{ old_string: "a\rb", new_string: "c\rd" }]);
    expect(result.isError).toBe(false);
    expect(read()).toBe("before\nc\rd\nafter\n");
  });

  it.each(["\r", "\r\r", "wrong\r\rtext"])(
    "leaves the file unchanged when cleaning %j finds no match",
    async (oldString) => {
      const original = "first\nsecond\n";
      const { edit, read } = await fixture(original);
      const result = await edit([
        { old_string: oldString, new_string: "changed" },
      ]);
      expect(result.isError).toBe(true);
      expect(result.output).toContain("not found in file");
      expect(read()).toBe(original);
    },
  );

  it("consumes the complete CRLF when an LF snippet starts with a newline", async () => {
    const { edit, read } = await fixture("first\r\nsecond\r\n");
    const result = await edit([
      { old_string: "\nsec\rond", new_string: "\nTH\rIRD" },
    ]);
    expect(result.isError).toBe(false);
    expect(read()).toBe("first\r\nTHIRD\r\n");
  });

  it.each([
    ["\n", "\n"],
    ["\n", "\r\n"],
    ["\r\n", "\n"],
    ["\r\n", "\r\n"],
  ])(
    "matches file line ending %j with edit line ending %j",
    async (fileEnding, editEnding) => {
      const { edit, read } = await fixture(
        ["header", "first", "second", "unchanged  ", ""].join(fileEnding),
      );
      const result = await edit([
        {
          old_string: ["first", "second"].join(editEnding),
          new_string: ["ONE", "TWO", "THREE"].join(editEnding),
        },
      ]);
      expect(result.isError).toBe(false);
      expect(read()).toBe(
        ["header", "ONE", "TWO", "THREE", "unchanged  ", ""].join(fileEnding),
      );
    },
  );

  it("matches mixed line endings and preserves the unchanged original bytes", async () => {
    const { edit, read } = await fixture(
      "\uFEFFheader 🐾\n\tfirst\r\n\tsecond\n\tthird\r\nunchanged  \r\nlast\n",
    );
    const result = await edit([
      {
        old_string: "\tfirst\r\n\tsecond\r\n\tthird",
        new_string: "\tONE\r\n\tTWO",
      },
      { old_string: "last\r\n", new_string: "LAST\r\n" },
    ]);
    expect(result.isError).toBe(false);
    expect(read()).toBe(
      "\uFEFFheader 🐾\n\tONE\r\n\tTWO\r\nunchanged  \r\nLAST\n",
    );
    expect(result.output).toContain("2 replacements");
  });

  it("rejects ambiguity across different line endings and replaces all when requested", async () => {
    const original = "first\nsecond\nfirst\r\nsecond\nfirst\nsecond";
    const { edit, read } = await fixture(original);
    const edits = [
      { old_string: "fi\rrst\r\nsec\rond", new_string: "O\rNE\r\nT\rWO" },
    ];
    const ambiguous = await edit(edits);
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.output).toContain("occurs more than once");
    expect(read()).toBe(original);

    const result = await edit([{ ...edits[0], replace_all: true }]);
    expect(result.isError).toBe(false);
    expect(result.output).toContain("3 replacements");
    expect(read()).toBe("ONE\nTWO\nONE\r\nTWO\nONE\nTWO");
  });

  it("rejects overlapping edits after line ending normalization", async () => {
    const original = "first\r\nsecond\nthird\r\n";
    const { edit, read } = await fixture(original);
    const result = await edit([
      { old_string: "first\nsecond", new_string: "ONE" },
      { old_string: "sec\rond\r\nthi\rrd", new_string: "TWO" },
    ]);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("overlaps another edit");
    expect(read()).toBe(original);
  });

  it("does not treat regex metacharacters or escaped carriage returns as patterns", async () => {
    const original = "before\n.*+?^${}()|[]\\r\nafter\n";
    const { edit, read } = await fixture(original);
    const result = await edit([
      {
        old_string: ".*+?^\r${}()|[]\\r\r\n",
        new_string: "$&\r $$ $` $'\r\n",
      },
    ]);
    expect(result.isError).toBe(false);
    expect(read()).toBe("before\n$& $$ $` $'\nafter\n");
  });

  it("does not split a CRLF into two line breaks", async () => {
    const original = "first\r\nsecond\r\n";
    const { edit, read } = await fixture(original);
    const result = await edit([
      { old_string: "first\n\nsecond", new_string: "changed" },
    ]);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("not found in file");
    expect(read()).toBe(original);
  });

  it("rejects changes that only differ in line ending encoding", async () => {
    const original = "first\r\nsecond\r\n";
    const { edit, read } = await fixture(original);
    const result = await edit([
      { old_string: "fi\rrst\r\nsec\rond", new_string: "first\nsecond" },
    ]);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("would not change the file");
    expect(read()).toBe(original);
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
