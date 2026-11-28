import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { unlink } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createTwoFilesPatch } from "diff";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createToolRegistry } from "@/bootstrap/tool-registry.js";
import { FileHistory, fileHistoryDir } from "@/file-history/index.js";
import { declaredFileOperations } from "@/session/file-operations.js";
import {
  BUILTIN_AGENTS,
  ASYNC_AGENT_ALLOWED_TOOLS,
} from "@/subagent/constants.js";
import { TaskList } from "@/todo/index.js";
import { ApplyPatchTool } from "@/tools/apply-patch.js";
import { withFileMutationQueue } from "@/tools/file-mutation-queue.js";
import { FileStateCache } from "@/tools/file-state-cache.js";
import { ReadFileTool } from "@/tools/read-file.js";
import type { ToolContext } from "@/tools/types.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return { ...actual, unlink: vi.fn(actual.unlink) };
});

let root: string;
let ctx: ToolContext;
const histories: string[] = [];
const tool = new ApplyPatchTool();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "yukino-patch-"));
  ctx = { cwd: root, fileStateCache: new FileStateCache() };
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(unlink).mockReset();
  rmSync(root, { recursive: true, force: true });
  for (const path of histories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

async function seed(
  path: string,
  content: string,
  read = true,
): Promise<string> {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  if (read) {
    expect(
      (await new ReadFileTool().execute(ctx, { file_path: file })).isError,
    ).toBe(false);
  }
  return file;
}
function history(): FileHistory {
  const id = `apply-patch-${randomUUID()}`;
  histories.push(fileHistoryDir(id));
  const value = new FileHistory(id);
  value.makeSnapshot("before-patch", "before patch");
  ctx.fileHistory = value;
  return value;
}

function change(
  path: string,
  before: string | null,
  after: string | null,
  destination = path,
): string {
  return createTwoFilesPatch(
    before === null ? "/dev/null" : path,
    after === null ? "/dev/null" : destination,
    before ?? "",
    after ?? "",
  );
}
function apply(patch: string, context = ctx) {
  return tool.execute(context, { patch });
}

describe("ApplyPatch unified diff tool", () => {
  it("registers a JSON-schema tool for all model protocols and writable agents", () => {
    const registry = createToolRegistry(new TaskList());
    expect(registry.get("ApplyPatch")).toBeInstanceOf(ApplyPatchTool);
    expect(registry.get("EditFile")).toBeDefined();
    expect(registry.get("WriteFile")).toBeDefined();
    expect(registry.getAllSchemas("openai")).toContainEqual(
      expect.objectContaining({
        name: "ApplyPatch",
        parameters: tool.schema().input_schema,
      }),
    );
    expect(registry.getAllSchemas("anthropic")).toContainEqual(
      expect.objectContaining({
        name: "ApplyPatch",
        input_schema: tool.schema().input_schema,
      }),
    );
    expect(
      registry
        .getAllSchemas("openai-compat")
        .map((schema) => schema.function.name),
    ).toContain("ApplyPatch");
    expect(ASYNC_AGENT_ALLOWED_TOOLS.has("ApplyPatch")).toBe(true);
    for (const agent of BUILTIN_AGENTS.filter(
      (agent) => agent.readOnly || agent.name === "review",
    )) {
      expect(agent.disallowedTools).toContain("ApplyPatch");
    }
  });

  it("adds, updates, deletes and moves files, updating history and state caches", async () => {
    const updated = await seed("update.txt", "one\ntwo\n");
    const deleted = await seed("delete.txt", "old\n");
    const moved = await seed("move.txt", "before\n");
    const target = await seed("target.txt", "overwritten\n");
    const value = history();
    const result = await apply(
      change("new.txt", null, "new\n") +
        change("update.txt", "one\ntwo\n", "one\nthree\n") +
        change("delete.txt", "old\n", null) +
        change("move.txt", "before\n", "after\n", "target.txt"),
    );
    expect(result.isError).toBe(false);
    expect(readFileSync(updated, "utf8")).toBe("one\nthree\n");
    expect(readFileSync(target, "utf8")).toBe("after\n");
    expect(existsSync(deleted)).toBe(false);
    expect(existsSync(moved)).toBe(false);
    expect(ctx.fileStateCache?.check(target)).toEqual({ ok: true });
    expect(
      declaredFileOperations(result.structuredContent)?.modifiedFiles,
    ).toEqual([join(root, "new.txt"), updated, deleted, moved, target]);
    value.rewind(value.getSnapshots()[0].id);
    expect(readFileSync(updated, "utf8")).toBe("one\ntwo\n");
    expect(readFileSync(target, "utf8")).toBe("overwritten\n");
    expect(readFileSync(moved, "utf8")).toBe("before\n");
    expect(readFileSync(deleted, "utf8")).toBe("old\n");
    expect(existsSync(join(root, "new.txt"))).toBe(false);
  });

  it("creates empty files and supports absolute paths", async () => {
    const path = join(root, "empty.txt");
    expect((await apply(change(path, null, ""))).isError).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("");
  });

  it("requires fresh reads for existing sources and overwritten move destinations", async () => {
    const source = await seed("source.txt", "old\n", false);
    expect((await apply(change("source.txt", "old\n", "new\n"))).isError).toBe(
      true,
    );
    await new ReadFileTool().execute(ctx, { file_path: source });
    const target = await seed("target.txt", "target\n", false);
    expect(
      (await apply(change("source.txt", "old\n", "new\n", "target.txt")))
        .isError,
    ).toBe(true);
    await new ReadFileTool().execute(ctx, { file_path: target });
    expect(
      (await apply(change("source.txt", "old\n", "new\n", "target.txt")))
        .isError,
    ).toBe(false);
  });

  it("rejects stale files, malformed patches and conflicting aliases before writing", async () => {
    const file = await seed("source.txt", "old\n");
    writeFileSync(file, "external\n");
    const future = new Date(Date.now() + 10_000);
    utimesSync(file, future, future);
    const patch =
      change("new.txt", null, "new\n") +
      change("source.txt", "external\n", "updated\n");
    expect((await apply(patch)).output).toContain("modified since last read");
    expect(existsSync(join(root, "new.txt"))).toBe(false);
    await new ReadFileTool().execute(ctx, { file_path: file });
    expect(
      (
        await apply(
          change("new.txt", null, "new\n") +
            change("source.txt", "missing\n", "updated\n"),
        )
      ).isError,
    ).toBe(true);
    expect(existsSync(join(root, "new.txt"))).toBe(false);
    symlinkSync(file, join(root, "alias.txt"));
    expect(
      (await apply(change("source.txt", "external\n", "new\n", "alias.txt")))
        .isError,
    ).toBe(true);
    expect(
      (
        await apply(
          change("same.txt", null, "a\n") + change("./same.txt", null, "b\n"),
        )
      ).isError,
    ).toBe(true);
    expect((await apply(patch)).isError).toBe(false);
  });

  it("rejects invalid UTF-8 and refuses to overwrite additions", async () => {
    const path = join(root, "invalid.txt");
    const bytes = Buffer.from([0xff]);
    writeFileSync(path, bytes);
    ctx.fileStateCache?.record(path, statSync(path).mtimeMs);
    expect(
      (
        await apply(
          change("new.txt", null, "new\n") + change("invalid.txt", "x", "y"),
        )
      ).output,
    ).toContain("UTF-8");
    expect(existsSync(join(root, "new.txt"))).toBe(false);
    expect(readFileSync(path)).toEqual(bytes);
    await seed("existing.txt", "existing\n");
    expect(
      (await apply(change("existing.txt", null, "replacement\n"))).output,
    ).toContain("already exists");
  });

  it("preserves CRLF, missing final newlines and executable mode without fuzzy matching", async () => {
    const path = await seed("source.txt", "one\r\ntwo");
    const patch = change("source.txt", "one\ntwo", "one\nthree");
    expect((await apply(patch)).isError).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("one\r\nthree");
    expect(
      (await apply(change("source.txt", " one\nthree", "one\nfour"))).isError,
    ).toBe(true);
    if (process.platform !== "win32") {
      const { chmodSync } = await import("node:fs");
      chmodSync(path, 0o755);
      await new ReadFileTool().execute(ctx, { file_path: path });
      expect(
        (await apply(change("source.txt", "one\nthree", "one\nfour"))).isError,
      ).toBe(false);
      expect(statSync(path).mode & 0o777).toBe(0o755);
    }
  });

  it("does not delete directories or symbolic links", async () => {
    mkdirSync(join(root, "directory"));
    expect((await apply(change("directory", "x", null))).isError).toBe(true);
    const source = await seed("source.txt", "source\n");
    symlinkSync(source, join(root, "link.txt"));
    expect((await apply(change("link.txt", "source\n", null))).isError).toBe(
      true,
    );
    expect(
      (
        await apply(
          change("link.txt", "source\n", "moved\n", "destination.txt"),
        )
      ).isError,
    ).toBe(true);
    expect(lstatSync(join(root, "link.txt")).isSymbolicLink()).toBe(true);
  });

  it("reports committed destinations when a move source cannot be removed", async () => {
    const source = await seed("source.txt", "source\n");
    const target = await seed("target.txt", "target\n");
    vi.mocked(unlink).mockRejectedValueOnce(new Error("remove blocked"));
    const result = await apply(
      change("source.txt", "source\n", "moved\n", "target.txt"),
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("remove blocked");
    expect(
      declaredFileOperations(result.structuredContent)?.modifiedFiles,
    ).toEqual([target]);
    expect(readFileSync(source, "utf8")).toBe("source\n");
    expect(readFileSync(target, "utf8")).toBe("moved\n");
  });

  it("preserves an external edit made after patch preflight without a read cache", async () => {
    const path = await seed("changed.txt", "before\n", false);
    const fileHistory = history();
    vi.spyOn(fileHistory, "trackEdit").mockImplementation(() => {
      writeFileSync(path, "external update\n");
    });
    const result = await apply(change("changed.txt", "before\n", "patch\n"), {
      cwd: root,
      fileHistory,
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Patch target changed");
    expect(readFileSync(path, "utf8")).toBe("external update\n");
  });

  it("reports partial commits if a later operation fails or is cancelled", async () => {
    await seed("deleted.txt", "old\n");
    vi.mocked(unlink).mockRejectedValueOnce(new Error("remove blocked"));
    const result = await apply(
      change("first.txt", null, "first\n") +
        change("deleted.txt", "old\n", null),
    );
    expect(result.isError).toBe(true);
    expect(
      declaredFileOperations(result.structuredContent)?.modifiedFiles,
    ).toEqual([join(root, "first.txt")]);
    const value = history();
    const controller = new AbortController();
    const track = value.trackEdit.bind(value);
    vi.spyOn(value, "trackEdit").mockImplementation((path) => {
      track(path);
      if (path === join(root, "cancelled.txt")) {
        controller.abort();
      }
    });
    const cancelled = await apply(
      change("written.txt", null, "written\n") +
        change("cancelled.txt", null, "cancelled\n"),
      { ...ctx, abortSignal: controller.signal },
    );
    expect(cancelled.isError).toBe(true);
    expect(
      declaredFileOperations(cancelled.structuredContent)?.modifiedFiles,
    ).toEqual([join(root, "written.txt")]);
    expect(existsSync(join(root, "cancelled.txt"))).toBe(false);
  });

  it("does not write after cancellation while waiting for a file queue", async () => {
    const path = join(root, "queued.txt");
    const ready = Promise.withResolvers<undefined>();
    const wait = Promise.withResolvers<undefined>();
    const blocker = withFileMutationQueue(path, async () => {
      ready.resolve(undefined);
      await wait.promise;
    });
    await ready.promise;
    const controller = new AbortController();
    const pending = apply(change("queued.txt", null, "new\n"), {
      ...ctx,
      abortSignal: controller.signal,
    });
    controller.abort();
    wait.resolve(undefined);
    await blocker;
    expect((await pending).isError).toBe(true);
    expect(existsSync(path)).toBe(false);
  });
});
