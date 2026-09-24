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

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { HookConfig } from "@/config/index.js";
import { HookEngine } from "@/hooks/index.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("hook execution boundaries", () => {
  it("consumes each anonymous once hook only after its condition matches", async () => {
    const hooks: HookConfig[] = ["first", "second"].map((prompt) => ({
      event: "pre_tool_use",
      condition: 'tool == "WriteFile"',
      once: true,
      action: { type: "prompt", prompt },
    }));
    const engine = new HookEngine(hooks);
    await engine.firePreToolHooks("ReadFile", {});
    expect(engine.drainNotifications()).toEqual([]);
    await engine.firePreToolHooks("WriteFile", {});
    expect(engine.drainNotifications()).toEqual(["first", "second"]);
    await engine.firePreToolHooks("WriteFile", {});
    expect(engine.drainNotifications()).toEqual([]);
  });

  it("honors prompt rejection and the documented bare tool condition", async () => {
    const engine = new HookEngine([
      {
        event: "pre_tool_use",
        condition: "Bash",
        reject: true,
        action: { type: "prompt", prompt: "blocked" },
      },
    ]);
    expect(await engine.firePreToolHooks("Bash", {})).toEqual({
      rejected: true,
      reason: "blocked",
    });
    expect(await engine.firePreToolHooks("ReadFile", {})).toEqual({
      rejected: false,
      reason: "",
    });
  });

  it.each([
    ['file_path =* "src/**/*.ts"', "src/file.ts", true],
    ['file_path =* "src/**/*.ts"', "src/a/b/file.ts", true],
    ['file_path =* "src/**/*.ts"', "src/fileXts", false],
    ['file_path =* "src/*.ts"', "src/a/file.ts", false],
    ['file_path == "a && b"', "a && b", true],
    [
      'tool == "ReadFile" || tool == "WriteFile" && file_path == "x"',
      "y",
      true,
    ],
  ])(
    "matches condition %s against %s",
    async (condition, filePath, matched) => {
      const engine = new HookEngine([
        {
          event: "pre_tool_use",
          condition,
          reject: true,
          action: { type: "prompt", prompt: "matched" },
        },
      ]);
      expect(
        (await engine.firePreToolHooks("ReadFile", { file_path: filePath }))
          .rejected,
      ).toBe(matched);
    },
  );

  it("runs commands in the agent work directory", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "yukino-hook-"));
    try {
      const engine = new HookEngine([
        { event: "pre_send", action: { type: "command", command: "pwd -P" } },
      ]);
      const results = await engine.fire(
        "pre_send",
        { event: "pre_send" },
        { workDir },
      );
      expect(results[0]?.output).toBe(realpathSync(workDir));
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("sends no body for GET and applies on_error to non-success HTTP status", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const engine = new HookEngine([
      {
        event: "pre_tool_use",
        on_error: "reject",
        action: { type: "http", url: "https://hooks.invalid", method: "get" },
      },
    ]);
    const result = await engine.firePreToolHooks("WriteFile", {});
    expect(result.rejected).toBe(true);
    expect(result.reason).toContain("503");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBeUndefined();
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("applies on_error to agent hook failures and stops the rejected chain", async () => {
    const engine = new HookEngine([
      {
        event: "pre_tool_use",
        on_error: "reject",
        action: { type: "agent", prompt: "inspect" },
      },
      {
        event: "pre_tool_use",
        action: { type: "command", command: "should-never-run" },
      },
    ]);
    expect((await engine.firePreToolHooks("WriteFile", {})).rejected).toBe(
      true,
    );
    engine.agentRunner = () => Promise.reject(new Error("runner failed"));
    const result = await engine.firePreToolHooks("WriteFile", {});
    expect(result.rejected).toBe(true);
    expect(result.reason).toContain("runner failed");
  });

  it("does not launch hooks after cancellation or enqueue synthetic async output", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("finished"));
    vi.stubGlobal("fetch", fetchMock);
    const engine = new HookEngine([
      {
        event: "pre_send",
        async: true,
        action: { type: "http", url: "https://hooks.invalid" },
      },
    ]);
    const controller = new AbortController();
    controller.abort();
    expect(
      await engine.fire(
        "pre_send",
        { event: "pre_send" },
        { abortSignal: controller.signal },
      ),
    ).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await engine.fire("pre_send", { event: "pre_send" })).toEqual([]);
    await vi.waitFor(() => {
      expect(engine.drainNotifications()).toEqual(["finished"]);
    });
  });
});
