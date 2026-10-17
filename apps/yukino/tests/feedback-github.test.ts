import type * as childProcess from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildIssueUrl,
  desiredLabels,
  detectChannel,
  FEEDBACK_REPO,
  fetchRepoLabels,
} from "@/feedback/github.js";

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
