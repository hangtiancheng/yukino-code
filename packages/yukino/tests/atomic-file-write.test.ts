import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { writeFileAtomically } from "@/tools/atomic-write.js";
import { EditFileTool } from "@/tools/edit-file.js";
import { FileStateCache } from "@/tools/file-state-cache.js";
import { ReadFileTool } from "@/tools/read-file.js";
import { WriteFileTool } from "@/tools/write-file.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "yukino-atomic-write-"));
  directories.push(cwd);
  const path = join(cwd, "source.ts");
  writeFileSync(path, "original\n");
  return { cwd, path };
}

describe("atomic tool writes", () => {
  it.each(["edit", "write"])(
    "retains the complete original when %s cannot commit",
    async (kind) => {
      const { cwd, path } = fixture();
      const context = { cwd, fileStateCache: new FileStateCache() };
      await new ReadFileTool().execute(context, { file_path: path });
      const commit = vi
        .mocked(fs.rename)
        .mockImplementationOnce(async (temporary, target) => {
          expect(String(target)).toBe(path);
          expect(readFileSync(path, "utf8")).toBe("original\n");
          expect(readFileSync(temporary, "utf8")).toBe("replacement\n");
          await Promise.resolve();
          throw new Error("commit failed");
        });
      const execute = () =>
        kind === "edit"
          ? new EditFileTool().execute(context, {
              file_path: path,
              edits: [{ old_string: "original", new_string: "replacement" }],
            })
          : new WriteFileTool().execute(context, {
              file_path: path,
              content: "replacement\n",
            });
      const failed = await execute();
      expect(failed.isError).toBe(true);
      expect(failed.output).toContain("commit failed");
      expect(readFileSync(path, "utf8")).toBe("original\n");
      expect(readdirSync(cwd)).toEqual(["source.ts"]);
      expect(context.fileStateCache.check(path).ok).toBe(true);
      expect(commit).toHaveBeenCalledOnce();
      expect((await execute()).isError).toBe(false);
      expect(readFileSync(path, "utf8")).toBe("replacement\n");
      expect(readdirSync(cwd)).toEqual(["source.ts"]);
    },
  );

  it("leaves an existing file intact when canceled", async () => {
    const { cwd, path } = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      writeFileAtomically(path, "replacement", controller.signal),
    ).rejects.toThrow();
    expect(readFileSync(path, "utf8")).toBe("original\n");
    expect(readdirSync(cwd)).toEqual(["source.ts"]);
  });

  it.skipIf(process.platform === "win32")(
    "preserves executable permissions and symlink targets",
    async () => {
      const { cwd, path } = fixture();
      chmodSync(path, 0o751);
      const link = join(cwd, "linked.ts");
      symlinkSync(path, link);
      await writeFileAtomically(link, "replacement");
      expect(readFileSync(path, "utf8")).toBe("replacement");
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(0o751);
      expect(readdirSync(cwd).sort()).toEqual(["linked.ts", "source.ts"]);
    },
  );
});
