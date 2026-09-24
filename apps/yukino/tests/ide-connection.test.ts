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

import { afterEach, describe, expect, it, vi } from "vitest";

import { connectToIde } from "@/vscode/ide-client.js";
import { detectIde } from "@/vscode/lockfile.js";

vi.mock("../src/vscode/lockfile.js", () => ({
  detectIde: vi.fn().mockResolvedValue(null),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("IDE discovery lifetime", () => {
  it("does not discover an IDE for an already cancelled UI", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      await connectToIde({
        cwd: "/tmp",
        onAtMentioned: vi.fn(),
        signal: controller.signal,
      }),
    ).toBeNull();
    expect(detectIde).not.toHaveBeenCalled();
  });

  it("cancels startup polling when the terminal exits", async () => {
    vi.stubEnv("TERM_PROGRAM", "vscode");
    const controller = new AbortController();
    const connecting = connectToIde({
      cwd: "/tmp",
      onAtMentioned: vi.fn(),
      signal: controller.signal,
    });
    await Promise.resolve();
    expect(detectIde).toHaveBeenCalledOnce();
    controller.abort();
    expect(await connecting).toBeNull();
    expect(detectIde).toHaveBeenCalledOnce();
  });
});
