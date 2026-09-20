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

import { describe, expect, it, vi } from "vitest";

import { createEmbedder, EMBED_BATCH_SIZE } from "@/tools/docs/embedder.js";

const embedManyMock = vi.hoisted(() =>
  vi.fn(async ({ values }: { values: string[] }) => ({
    embeddings: values.map((value) => [value.length]),
  })),
);
const embedMock = vi.hoisted(() =>
  vi.fn(async ({ value }: { value: string }) => ({
    embedding: [value.length],
  })),
);

vi.mock("ai", () => ({
  embed: embedMock,
  embedMany: embedManyMock,
}));

const config = {
  model: "test-model",
  baseUrl: "http://localhost:8",
  apiKey: "k",
};

describe("embedTexts batching", () => {
  it("splits inputs into provider-sized batches preserving order", async () => {
    const embedder = createEmbedder(config);
    const texts = Array.from({ length: 25 }, (_, i) => "x".repeat(i + 1));

    const vectors = await embedder.embedTexts(texts);

    expect(embedManyMock).toHaveBeenCalledTimes(3);
    const sizes = embedManyMock.mock.calls.map(([args]) => args.values.length);
    expect(sizes).toEqual([EMBED_BATCH_SIZE, EMBED_BATCH_SIZE, 5]);
    expect(vectors).toEqual(texts.map((t) => [t.length]));
  });

  it("returns empty output for empty input without calling the provider", async () => {
    embedManyMock.mockClear();
    const embedder = createEmbedder(config);
    expect(await embedder.embedTexts([])).toEqual([]);
    expect(embedManyMock).not.toHaveBeenCalled();
  });
});

describe("embedText", () => {
  it("embeds a single value", async () => {
    const embedder = createEmbedder(config);
    expect(await embedder.embedText("abc")).toEqual([3]);
  });
});
