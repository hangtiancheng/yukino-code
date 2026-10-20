import type * as childProcess from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { FEEDBACK_REPO } from "@/feedback/constants.js";
import {
  buildIssueUrl,
  createGist,
  desiredLabels,
  detectChannel,
  fetchRepoLabels,
} from "@/feedback/github.js";
import type { CollectedFile } from "@/feedback/types.js";

interface ExecFileResult {
  stdout: string;
  stderr: string;
}

type ExecFileFn = (
  cmd: string,
  args: string[],
  opts?: unknown,
) => Promise<ExecFileResult>;

const { execFileImpl } = vi.hoisted(() => ({
  execFileImpl: vi.fn<ExecFileFn>(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof childProcess>();
  const util = await import("node:util");
  const mocked = Object.assign(
    (
      cmd: string,
      args: string[],
      opts: unknown,
      cb?: (err: Error | null) => void,
    ) => {
      const promise: Promise<ExecFileResult> = execFileImpl(cmd, args, opts);
      void promise.then(
        () => cb?.(null),
        (err: unknown) =>
          cb?.(err instanceof Error ? err : new Error(String(err))),
      );
    },
    {
      [util.promisify.custom]: (
        cmd: string,
        args: string[],
        opts: unknown,
      ): Promise<ExecFileResult> => execFileImpl(cmd, args, opts),
    },
  );
  return { ...original, execFile: mocked };
});

describe("createGist", () => {
  const files: CollectedFile[] = [
    { name: "log.jsonl", content: "", truncated: false },
    { name: "whitespace.txt", content: " \r\n\t", truncated: false },
    {
      name: "source.ts",
      content: "export const value = 1;\n",
      truncated: false,
    },
  ];

  beforeEach(() => {
    execFileImpl.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function checkUploadedFiles(uploaded: Record<string, { content: string }>) {
    expect(Object.keys(uploaded).sort()).toEqual(
      files.map((file) => file.name).sort(),
    );
    for (const file of files) {
      const content = uploaded[file.name].content;
      expect(content.trim()).not.toBe("");
      if (file.content.trim()) {
        expect(content).toBe(file.content);
      } else {
        const encoded: unknown = JSON.parse(content);
        const parsed = z
          .object({ _note: z.string(), content: z.string() })
          .parse(encoded);
        expect(parsed._note.trim()).not.toBe("");
        expect(parsed.content).toBe(file.content);
      }
    }
  }

  it("uploads blank attachments via gh without losing their original content", async () => {
    const uploaded: Record<string, { content: string }> = {};
    const original = structuredClone(files);
    let paths: string[] = [];
    execFileImpl.mockImplementation((command, args) => {
      expect(command).toBe("gh");
      expect(args.slice(0, 2)).toEqual(["gist", "create"]);
      paths = args.slice(2, args.indexOf("--desc"));
      for (const path of paths) {
        uploaded[basename(path)] = { content: readFileSync(path, "utf-8") };
      }
      return Promise.resolve({
        stdout: "https://gist.github.com/test\n",
        stderr: "",
      });
    });

    expect(await createGist("gh", files, "test")).toBe(
      "https://gist.github.com/test",
    );
    checkUploadedFiles(uploaded);
    expect(files).toEqual(original);
    expect(paths.every((path) => !existsSync(path))).toBe(true);
  });

  it("uploads blank attachments via the API with the same lossless encoding", async () => {
    vi.stubEnv("GH_TOKEN", "test-token");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ html_url: "https://gist.github.com/test" }),
      );
    vi.stubGlobal("fetch", fetchMock);

    expect(await createGist("token", files, "test")).toBe(
      "https://gist.github.com/test",
    );
    const payload: unknown = JSON.parse(
      z.string().parse(fetchMock.mock.calls[0]?.[1]?.body),
    );
    const parsed = z
      .object({
        public: z.boolean(),
        files: z.record(z.string(), z.object({ content: z.string() })),
      })
      .parse(payload);
    expect(parsed.public).toBe(false);
    checkUploadedFiles(parsed.files);
  });
});

describe("detectChannel", () => {
  beforeEach(() => {
    // Empty strings are falsy for the token lookup, so this means "no token".
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
    execFileImpl.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers an authenticated gh CLI", async () => {
    execFileImpl.mockResolvedValue({ stdout: "gh version 2.0", stderr: "" });
    expect(await detectChannel()).toBe("gh");
  });

  it("falls back to the token when gh is missing", async () => {
    execFileImpl.mockRejectedValue(new Error("spawn gh ENOENT"));
    vi.stubEnv("GITHUB_TOKEN", "ghp_test");
    expect(await detectChannel()).toBe("token");
  });

  it("falls back to the token when gh is not logged in", async () => {
    execFileImpl
      .mockResolvedValueOnce({ stdout: "gh version 2.0", stderr: "" })
      .mockRejectedValueOnce(new Error("not logged in"));
    vi.stubEnv("GH_TOKEN", "ghp_test");
    expect(await detectChannel()).toBe("token");
  });

  it("falls back to the browser with no gh and no token", async () => {
    execFileImpl.mockRejectedValue(new Error("spawn gh ENOENT"));
    expect(await detectChannel()).toBe("browser");
  });
});

describe("desiredLabels", () => {
  it("intersects with existing repo labels", () => {
    expect(desiredLabels(["bug", "enhancement"])).toEqual(["bug"]);
    expect(desiredLabels([])).toEqual([]);
    expect(desiredLabels(["yukino-feedback", "bug"])).toEqual([
      "bug",
      "yukino-feedback",
    ]);
  });
});

describe("fetchRepoLabels", () => {
  beforeEach(() => {
    execFileImpl.mockReset();
  });

  it("flattens slurped gh pages and requests --slurp", async () => {
    execFileImpl.mockResolvedValue({
      stdout: JSON.stringify([
        [{ name: "bug" }],
        [{ name: "yukino-feedback" }, { name: "docs" }],
      ]),
      stderr: "",
    });
    expect(await fetchRepoLabels("gh")).toEqual([
      "bug",
      "yukino-feedback",
      "docs",
    ]);
    const args: string[] = execFileImpl.mock.calls[0][1];
    expect(args).toContain("--paginate");
    expect(args).toContain("--slurp");
  });

  it("returns [] when gh emits non-JSON output", async () => {
    // Pre-slurp concatenated pages would look like this and must not crash.
    execFileImpl.mockResolvedValue({
      stdout: '[{"name":"bug"}][{"name":"x"}]',
      stderr: "",
    });
    expect(await fetchRepoLabels("gh")).toEqual([]);
  });

  it("returns [] when gh fails", async () => {
    execFileImpl.mockRejectedValue(new Error("gh: command not found"));
    expect(await fetchRepoLabels("gh")).toEqual([]);
  });
});

describe("buildIssueUrl", () => {
  it("builds a prefill URL for short bodies", () => {
    const url = buildIssueUrl(
      "[tool] Bash fails",
      "## What happened\nIt hung.",
    );
    expect(
      url.startsWith(`https://github.com/${FEEDBACK_REPO}/issues/new?title=`),
    ).toBe(true);
    expect(url).toContain(encodeURIComponent("[tool] Bash fails"));
    expect(url).toContain(encodeURIComponent("It hung."));
    expect(url.length).toBeLessThanOrEqual(7250);
  });

  it("truncates oversized bodies within the URL limit without breaking %XX", () => {
    // CJK chars encode to multi-byte %XX sequences that a naive slice can cut.
    const body = "故障现场还原".repeat(3000);
    const url = buildIssueUrl("[context] 压缩丢失消息", body);
    expect(url.length).toBeLessThanOrEqual(7250);
    expect(url).toContain(encodeURIComponent("content truncated"));
    // No dangling percent-escape: every % is followed by 2 hex digits.
    const bodyParam = url.slice(url.indexOf("&body=") + 6);
    for (let i = 0; i < bodyParam.length; i++) {
      if (bodyParam[i] === "%") {
        expect(i + 2).toBeLessThan(bodyParam.length);
        expect(/^[0-9A-Fa-f]{2}$/.test(bodyParam.slice(i + 1, i + 3))).toBe(
          true,
        );
      }
    }
    // The truncated URL must still decode.
    expect(() => decodeURIComponent(bodyParam)).not.toThrow();
  });
});
