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

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { Sandbox } from "@/sandbox/index.js";
import { BashTool } from "@/tools/bash.js";
import { EditFileTool } from "@/tools/edit-file.js";
import { withFileMutationQueue } from "@/tools/file-mutation-queue.js";
import { FileStateCache } from "@/tools/file-state-cache.js";
import { PowerShellTool } from "@/tools/powershell.js";
import { ReadFileTool } from "@/tools/read-file.js";
import {
  formatShellOutput,
  takeUtf8Prefix,
  utf8ByteLength,
} from "@/tools/shell-output.js";
import type { ToolContext } from "@/tools/types.js";
import { WriteFileTool } from "@/tools/write-file.js";

function makeContext(): ToolContext {
  return {
    workDir: mkdtempSync(join(tmpdir(), "yukino-tools-")),
    fileStateCache: new FileStateCache(),
  };
}

describe("file tool boundaries", () => {
  it("bounds large reads and rejects offsets past EOF", async () => {
    const context = makeContext();
    const path = join(context.workDir, "large.txt");
    writeFileSync(
      path,
      Array.from(
        { length: 1_000 },
        (_, i) => `${String(i)} ${"あ".repeat(30)}`,
      ).join("\n"),
    );

    const result = await new ReadFileTool().execute(context, {
      file_path: path,
    });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("more lines in file");
    expect(result.output).toContain("Use offset=");
    const returnedContent = result.output.split("\n[")[0] ?? result.output;
    expect(utf8ByteLength(returnedContent)).toBeLessThanOrEqual(50 * 1024);

    const beyond = await new ReadFileTool().execute(context, {
      file_path: path,
      offset: 1_000,
    });
    expect(beyond.isError).toBe(true);
    expect(beyond.output).toContain("is beyond end of file");
  });

  it("rejects missing write content and missing edit replacement", async () => {
    const context = makeContext();
    const path = join(context.workDir, "file.txt");
    const write = await new WriteFileTool().execute(context, {
      file_path: path,
    });
    expect(write).toEqual({
      output: "Error: content is required",
      isError: true,
    });

    writeFileSync(path, "before");
    await new ReadFileTool().execute(context, { file_path: path });
    const edit = await new EditFileTool().execute(context, {
      file_path: path,
      old_string: "before",
    });
    expect(edit).toEqual({
      output: "Error: new_string is required",
      isError: true,
    });
    expect(readFileSync(path, "utf-8")).toBe("before");
  });

  it("inserts new_string verbatim without expanding JS replacement patterns", async () => {
    const context = makeContext();
    const path = join(context.workDir, "dollar.txt");
    writeFileSync(path, "prefix MATCH suffix");
    await new ReadFileTool().execute(context, { file_path: path });

    // With a string replacement argument, JS would collapse the double-dollar
    // to one, expand dollar-ampersand to the match, and dollar-backtick /
    // dollar-quote to the text before / after the match.
    const edit = await new EditFileTool().execute(context, {
      file_path: path,
      old_string: "MATCH",
      new_string: "$$! $& $` $'",
    });
    expect(edit.isError).toBe(false);
    expect(readFileSync(path, "utf-8")).toBe("prefix $$! $& $` $' suffix");

    const allPath = join(context.workDir, "dollar-all.txt");
    writeFileSync(allPath, "a a");
    await new ReadFileTool().execute(context, { file_path: allPath });
    const editAll = await new EditFileTool().execute(context, {
      file_path: allPath,
      old_string: "a",
      new_string: "$&$",
      replace_all: true,
    });
    expect(editAll.isError).toBe(false);
    expect(readFileSync(allPath, "utf-8")).toBe("$&$ $&$");
  });

  it("serializes concurrent edits to the same file", async () => {
    const context = makeContext();
    const path = join(context.workDir, "concurrent.txt");
    writeFileSync(path, "first\nsecond");
    await new ReadFileTool().execute(context, { file_path: path });

    const [first, second] = await Promise.all([
      new EditFileTool().execute(context, {
        file_path: path,
        old_string: "first",
        new_string: "FIRST",
      }),
      new EditFileTool().execute(context, {
        file_path: path,
        old_string: "second",
        new_string: "SECOND",
      }),
    ]);
    expect(first.isError).toBe(false);
    expect(second.isError).toBe(false);
    expect(readFileSync(path, "utf-8")).toBe("FIRST\nSECOND");
  });

  it("serializes edits through symlink aliases", async () => {
    const context = { workDir: mkdtempSync(join(tmpdir(), "yukino-tools-")) };
    const realDir = join(context.workDir, "real");
    const aliasDir = join(context.workDir, "alias");
    mkdirSync(realDir);
    symlinkSync(realDir, aliasDir, "dir");
    writeFileSync(join(realDir, "file.txt"), "first\nsecond");

    const [first, second] = await Promise.all([
      new EditFileTool().execute(context, {
        file_path: "real/file.txt",
        old_string: "first",
        new_string: "FIRST",
      }),
      new EditFileTool().execute(context, {
        file_path: "alias/file.txt",
        old_string: "second",
        new_string: "SECOND",
      }),
    ]);
    expect(first.isError).toBe(false);
    expect(second.isError).toBe(false);
    expect(readFileSync(join(realDir, "file.txt"), "utf-8")).toBe(
      "FIRST\nSECOND",
    );
  });

  it("checks cancellation after waiting for a mutation lock", async () => {
    const context = makeContext();
    const path = join(context.workDir, "locked.txt");
    writeFileSync(path, "before");
    let release: () => void = () => {
      /** noop */
    };
    const blocker = withFileMutationQueue(
      path,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const controller = new AbortController();
    const pending = new WriteFileTool().execute(
      { ...context, abortSignal: controller.signal },
      { file_path: path, content: "after" },
    );
    controller.abort();
    release();
    await blocker;
    const result = await pending;
    expect(result).toEqual({
      output: "Error: operation interrupted",
      isError: true,
    });
    expect(readFileSync(path, "utf-8")).toBe("before");
  });

  it("rejects an externally changed file whose mtime moved backwards", () => {
    const context = makeContext();
    const path = join(context.workDir, "stale.txt");
    writeFileSync(path, "content");
    const original = statSync(path).mtimeMs;
    context.fileStateCache?.record(path, original);
    const earlier = new Date(Math.max(0, original - 10_000));
    utimesSync(path, earlier, earlier);
    expect(context.fileStateCache?.check(path)).toEqual({
      ok: false,
      error:
        "Error: file has been modified since last read, read it again before editing.",
    });
  });
});

describe("shell tool boundaries", () => {
  it("keeps UTF-8 output limits on character boundaries", () => {
    const prefix = takeUtf8Prefix("あああ", 7);
    expect(prefix).toBe("ああ");
    expect(utf8ByteLength(prefix)).toBeLessThanOrEqual(7);
    expect(formatShellOutput("$ ", "printf", prefix, "", true)).toContain(
      "[Output truncated after 10 MB]",
    );
  });

  it("reports non-zero Bash exits as tool errors", async () => {
    const result = await new BashTool().execute(makeContext(), {
      command: "exit 7",
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Exit code 7");
  });

  it("marks output that crosses the shell byte boundary", async () => {
    const result = await new BashTool().execute(makeContext(), {
      command: "node -e 'process.stdout.write(\"あ\".repeat(4000000))'",
      timeout: 10,
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("[Output truncated after 10 MB]");
  }, 15_000);

  it("preserves captured Bash output when cancellation interrupts a command", async () => {
    const context = makeContext();
    const controller = new AbortController();
    const pending = new BashTool().execute(
      { ...context, abortSignal: controller.signal },
      { command: "printf before; sleep 10" },
    );
    setTimeout(() => {
      controller.abort();
    }, 50);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.output).toContain("before");
    expect(result.output).toContain("command interrupted");
  }, 5_000);

  it("returns promptly when the shell exits with a daemonized grandchild still running", async () => {
    // fd-mode stdio: the child writes straight to the output file, so a
    // grandchild that inherits the fd (`sleep 2 &`) no longer holds the tool
    // result hostage — the call resolves as soon as the shell itself exits.
    const started = Date.now();
    const result = await new BashTool().execute(makeContext(), {
      command: "printf before; sleep 2 &",
    });
    expect(Date.now() - started).toBeLessThan(1_800);
    expect(result.isError).toBe(false);
    expect(result.output).toContain("before");
  }, 5_000);

  it("times out a still-running command at its deadline", async () => {
    const result = await new BashTool().execute(makeContext(), {
      command: "sleep 5",
      timeout: 1,
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("command timed out after 1s");
  }, 2_500);

  it("rejects non-positive timeouts before starting either shell", async () => {
    const context = makeContext();
    const expected = {
      output: "Error: timeout must be a finite number greater than 0 seconds",
      isError: true,
    };
    await expect(
      new BashTool().execute(context, { command: "true", timeout: 0 }),
    ).resolves.toEqual(expected);
    await expect(
      new PowerShellTool().execute(context, {
        command: "Write-Output ok",
        timeout: -1,
      }),
    ).resolves.toEqual(expected);
  });

  it("fails closed when a required sandbox is unavailable", async () => {
    const prepare = vi.fn();
    const sandbox: Sandbox = {
      implementation: "bwrap",
      available: () => false,
      prepare,
    };
    const tool = new BashTool();
    tool.sandboxRequired = true;
    tool.sandbox = sandbox;

    const result = await tool.execute(makeContext(), {
      command: "printf unsafe",
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("command was not executed");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("runs sandbox cleanup after a prepared command completes", async () => {
    const cleanup = vi.fn();
    const sandbox: Sandbox = {
      implementation: "seatbelt",
      available: () => true,
      prepare: () => ({
        executable: "bash",
        args: ["-c", "printf sandboxed"],
        cleanup,
      }),
    };
    const tool = new BashTool();
    tool.sandbox = sandbox;

    const result = await tool.execute(makeContext(), {
      command: "printf original",
    });

    expect(result.isError).toBe(false);
    expect(result.output).toContain("sandboxed");
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
