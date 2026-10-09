import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PathSandbox } from "@/permissions/index.js";
import { EditFileTool } from "@/tools/edit-file.js";
import { withFileMutationQueue } from "@/tools/file-mutation-queue.js";
import { FileStateCache } from "@/tools/file-state-cache.js";
import { GlobTool } from "@/tools/glob.js";
import { GrepTool } from "@/tools/grep.js";
import { ReadFileTool } from "@/tools/read-file.js";
import { MAX_SEARCH_OUTPUT_BYTES } from "@/tools/search-output.js";
import type { ToolContext } from "@/tools/types.js";
import { WriteFileTool } from "@/tools/write-file.js";
import { resolveToolPath } from "@/utils/paths.js";

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof os>()),
  homedir: vi.fn(),
}));

let root: string;
let home: string;
let ctx: ToolContext;
beforeEach(() => {
  root = mkdtempSync(join(os.tmpdir(), "yukino-pi-tools-"));
  home = join(root, "home");
  mkdirSync(home);
  vi.mocked(os.homedir).mockReturnValue(home);
  const cwd = join(root, "project");
  mkdirSync(cwd);
  ctx = { cwd, fileStateCache: new FileStateCache() };
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("file paths and queued writes", () => {
  it("uses the same home path for read, write, edit, search and the file cache", async () => {
    const file = join(home, "notes.txt");
    writeFileSync(file, "Original note");
    expect(
      (await new ReadFileTool().execute(ctx, { file_path: "~/notes.txt" }))
        .output,
    ).toBe("1\tOriginal note");
    expect(ctx.fileStateCache?.has(file)).toBe(true);
    expect(
      (
        await new EditFileTool().execute(ctx, {
          file_path: "~/notes.txt",
          edits: [{ old_string: "Original", new_string: "Edited" }],
        })
      ).isError,
    ).toBe(false);
    expect(
      (
        await new WriteFileTool().execute(ctx, {
          file_path: "~/notes.txt",
          content: "Final note",
        })
      ).isError,
    ).toBe(false);
    expect(readFileSync(file, "utf8")).toBe("Final note");
    expect(
      (await new GrepTool().execute(ctx, { path: "~", pattern: "Final" }))
        .output,
    ).toContain("notes.txt:1:Final note");
    expect(
      (await new GlobTool().execute(ctx, { path: "~", pattern: "*.txt" }))
        .output,
    ).toBe("notes.txt");
    expect(resolveToolPath(ctx.cwd, "~someone/file")).toBe(
      join(ctx.cwd, "~someone/file"),
    );
  });

  it("checks expanded home paths against the actual allowed roots", () => {
    vi.mocked(os.homedir).mockReturnValue("/outside-yukino-project/home");
    const sandbox = new PathSandbox(ctx.cwd);
    expect(sandbox.check("~/private.txt")?.effect).toBe("deny");
    expect(sandbox.check("~")?.effect).toBe("deny");
    sandbox.addRoot("~/allowed");
    expect(sandbox.check("~/allowed/file.txt")).toBeNull();
    expect(sandbox.check("~/allowed-extra/file.txt")?.effect).toBe("deny");
  });

  it("does not write when cancelled while waiting for the file mutation queue", async () => {
    const file = join(ctx.cwd, "queued.txt");
    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocker = withFileMutationQueue(file, async () => {
      entered();
      await waiting;
    });
    await started;
    const controller = new AbortController();
    const writing = new WriteFileTool().execute(
      { ...ctx, abortSignal: controller.signal },
      {
        file_path: file,
        content: "must not be written",
      },
    );
    controller.abort();
    release();
    await blocker;
    expect(await writing).toEqual({
      output: "Error: operation interrupted",
      isError: true,
    });
    expect(existsSync(file)).toBe(false);
    expect(ctx.fileStateCache?.has(file)).toBe(false);
  });
});

describe("bounded cancellable searches", () => {
  it("bounds UTF-8 grep output and marks shortened lines with their original line numbers", async () => {
    const file = join(ctx.cwd, "large.txt");
    writeFileSync(
      file,
      Array.from({ length: 500 }, () => `needle ${"かな🙂".repeat(400)}`).join(
        "\n",
      ),
    );
    const result = await new GrepTool().execute(ctx, {
      path: file,
      pattern: "needle",
    });
    expect(result.isError).toBe(false);
    const [body] = result.output.split("\n\n");
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(
      MAX_SEARCH_OUTPUT_BYTES,
    );
    expect(body).toContain("large.txt:1:needle");
    expect(body).toContain("…");
    expect(body).not.toContain("�");
    expect(result.output).toContain("results truncated at 50KB");
    expect(result.output).toContain("long matching line(s) shortened");
  });

  it("does not report truncation for exactly 500 grep matches", async () => {
    const file = join(ctx.cwd, "exact.txt");
    writeFileSync(file, "needle\n".repeat(500));
    const result = await new GrepTool().execute(ctx, {
      path: file,
      pattern: "needle",
    });
    expect(result.output.split("\n")).toHaveLength(500);
    expect(result.output).not.toContain("truncated");
    writeFileSync(file, "needle\n".repeat(501));
    expect(
      (await new GrepTool().execute(ctx, { path: file, pattern: "needle" }))
        .output,
    ).toContain("truncated at 500 matches");
  });

  it("bounds glob results containing long paths", async () => {
    for (let index = 0; index < 300; index++) {
      writeFileSync(
        join(ctx.cwd, `${"a".repeat(200)}-${String(index)}.txt`),
        "",
      );
    }
    const result = await new GlobTool().execute(ctx, { pattern: "*.txt" });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("Results limited to 50KB");
    expect(
      Buffer.byteLength(result.output.split("\n(")[0]),
    ).toBeLessThanOrEqual(MAX_SEARCH_OUTPUT_BYTES);
  });

  it.each(["grep", "glob"])(
    "interrupts an in-flight %s instead of returning a successful partial search",
    async (kind) => {
      const file = join(ctx.cwd, "file.txt");
      writeFileSync(file, "needle\n".repeat(1000));
      const controller = new AbortController();
      const tool = kind === "grep" ? new GrepTool() : new GlobTool();
      const pending = tool.execute(
        { ...ctx, abortSignal: controller.signal },
        { pattern: kind === "grep" ? "needle" : "*.txt" },
      );
      controller.abort();
      expect(await pending).toEqual({
        output: "Error: operation interrupted",
        isError: true,
      });
    },
  );

  it.each([new GrepTool(), new GlobTool()])(
    "does not begin an already-cancelled search with $name",
    async (tool) => {
      const controller = new AbortController();
      controller.abort();
      expect(
        await tool.execute(
          { ...ctx, abortSignal: controller.signal },
          { pattern: "*" },
        ),
      ).toEqual({ output: "Error: operation interrupted", isError: true });
    },
  );
});
