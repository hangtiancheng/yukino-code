import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AskUserQuestionTool } from "@/tools/ask-user.js";
import { EditFileTool } from "@/tools/edit-file.js";
import { ReadFileTool } from "@/tools/read-file.js";
import { SyntheticOutputTool } from "@/tools/synthetic-output.js";
import { WriteFileTool } from "@/tools/write-file.js";

const directories: string[] = [];
function context() {
  const cwd = mkdtempSync(join(tmpdir(), "yukino-tool-validation-"));
  directories.push(cwd);
  return { cwd };
}
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("tool input validation before side effects", () => {
  it("rejects invalid and undeclared write arguments without touching the filesystem", async () => {
    const ctx = context();
    const path = join(ctx.cwd, "file.txt");
    for (const args of [
      { file_path: path, content: 123 },
      { file_path: path, content: "data", overwrite: true },
    ]) {
      const result = await new WriteFileTool().execute(ctx, args);
      expect(result.isError).toBe(true);
      expect(existsSync(path)).toBe(false);
    }
  });
  it("rejects numeric strings and invalid ranges at the read boundary", async () => {
    const ctx = context();
    const path = join(ctx.cwd, "file.txt");
    writeFileSync(path, "data");
    for (const offset of ["1", -1, 1.5]) {
      expect(
        (await new ReadFileTool().execute(ctx, { file_path: path, offset }))
          .isError,
      ).toBe(true);
    }
  });
  it("does not partially apply edits when a later edit is invalid", async () => {
    const ctx = context();
    const path = join(ctx.cwd, "file.txt");
    writeFileSync(path, "before");
    const result = await new EditFileTool().execute(ctx, {
      file_path: path,
      edits: [
        { old_string: "before", new_string: "after" },
        { old_string: "after" },
      ],
    });
    expect(result.isError).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("before");
  });
  it("checks question option limits before asking the user", async () => {
    const ask = vi.fn(() => Promise.resolve({}));
    const tool = new AskUserQuestionTool(ask);
    const result = await tool.execute(context(), {
      questions: [
        {
          question: "Pick",
          options: [{ label: "Only one" }],
          multiSelect: false,
        },
      ],
    });
    expect(result.isError).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });
  it("validates nested structured output constraints", async () => {
    const tool = new SyntheticOutputTool({
      type: "object",
      properties: {
        items: { type: "array", items: { type: "integer", minimum: 1 } },
      },
      required: ["items"],
      additionalProperties: false,
    });
    expect(
      (await tool.execute(context(), { output: { items: [0] } })).isError,
    ).toBe(true);
    expect(
      (await tool.execute(context(), { output: { items: [1] } })).isError,
    ).toBe(false);
  });
});
