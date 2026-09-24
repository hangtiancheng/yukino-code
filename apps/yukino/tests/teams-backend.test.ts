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

import { describe, test, expect, afterEach } from "vitest";

import { detectBackend, detectBackendFromEnv } from "@/teams/backend.js";

const origTmux = process.env.TMUX;
const origIterm = process.env.ITERM_SESSION_ID;

afterEach(() => {
  if (origTmux === undefined) {
    delete process.env.TMUX;
  } else {
    process.env.TMUX = origTmux;
  }
  if (origIterm === undefined) {
    delete process.env.ITERM_SESSION_ID;
  } else {
    process.env.ITERM_SESSION_ID = origIterm;
  }
});

describe("detectBackendFromEnv (platform-agnostic)", () => {
  test("inside tmux picks tmux", () => {
    process.env.TMUX = "/tmp/sock,1,0";
    delete process.env.ITERM_SESSION_ID;
    expect(detectBackendFromEnv()).toBe("tmux");
  });
  test("inside iterm2 picks iterm", () => {
    delete process.env.TMUX;
    process.env.ITERM_SESSION_ID = "w0t0p0:ABC";
    expect(detectBackendFromEnv()).toBe("iterm");
  });
  test("tmux wins over iterm", () => {
    process.env.TMUX = "/tmp/sock,1,0";
    process.env.ITERM_SESSION_ID = "w0t0p0:ABC";
    expect(detectBackendFromEnv()).toBe("tmux");
  });
  test("plain terminal falls back to in-process", () => {
    delete process.env.TMUX;
    delete process.env.ITERM_SESSION_ID;
    expect(detectBackendFromEnv()).toBe("in-process");
  });
});

describe("detectBackend Windows guardrail", () => {
  test("inside a tmux session: Windows uses in-process, other platforms use tmux", () => {
    process.env.TMUX = "/tmp/sock,1,0";
    const got = detectBackend();
    if (process.platform === "win32") {
      expect(got).toBe("in-process");
    } else {
      expect(got).toBe("tmux");
    }
  });
});
