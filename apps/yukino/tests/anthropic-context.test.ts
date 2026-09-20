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

import { describe, it, expect, afterEach } from "vitest";

import type { ProviderConfig } from "@/config/index.js";
import { fetchModelContextWindow } from "@/llm/anthropic.js";

const anthropicProvider = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  name: "p",
  protocol: "anthropic",
  base_url: "https://api.example.com",
  model: "claude-sonnet-4-6",
  api_key: "sk-test",
  ...over,
});

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("fetchModelContextWindow (layer 2 auto-fetch)", () => {
  it("returns max_input_tokens on a successful response", async () => {
    let calledUrl = "";
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error
    globalThis.fetch = (url: string) => {
      calledUrl = url;
      return {
        ok: true,
        json: () => ({ max_input_tokens: 750_000 }),
      };
    };

    const got = await fetchModelContextWindow(anthropicProvider());
    expect(got).toBe(750_000);
    expect(calledUrl).toBe("https://api.example.com/v1/models/claude-sonnet-4-6");
  });

  it("returns 0 (graceful) when fetch throws — never propagates", async () => {
    globalThis.fetch = () => {
      throw new Error("network down");
    };

    // Must resolve, not reject.
    await expect(fetchModelContextWindow(anthropicProvider())).resolves.toBe(0);
  });

  it("returns 0 on a non-OK HTTP status", async () => {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error
    globalThis.fetch = () => ({
      ok: false,
      status: 404,
      json: () => ({}),
    });

    expect(await fetchModelContextWindow(anthropicProvider())).toBe(0);
  });

  it("returns 0 when max_input_tokens is missing or null", async () => {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error
    globalThis.fetch = () => ({
      ok: true,
      json: () => ({ max_input_tokens: null }),
    });

    expect(await fetchModelContextWindow(anthropicProvider())).toBe(0);
  });

  it("returns 0 immediately for non-anthropic protocols without fetching", async () => {
    let called = false;
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error
    globalThis.fetch = () => {
      called = true;
      return {
        ok: true,
        json: () => ({ max_input_tokens: 1 }),
      };
    };

    const got = await fetchModelContextWindow(anthropicProvider({ protocol: "openai-compat" }));
    expect(got).toBe(0);
    expect(called).toBe(false);
  });
});
