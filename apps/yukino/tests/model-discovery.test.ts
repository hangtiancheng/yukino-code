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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProviderConfig } from "@/config/index.js";
import { discoverModels, modelListUrl } from "@/llm/model-discovery.js";

const protocols: ProviderConfig["protocol"][] = [
  "anthropic",
  "openai",
  "openai-compat",
];
const connection = {
  protocol: protocols[0] ?? "anthropic",
  base_url: "https://provider.example",
  api_key: "secret-key",
};
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(Response.json({ data: [] }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each(protocols)("modelListUrl (%s)", (protocol) => {
  it.each([
    "",
    "/",
    "/v1",
    "/v1/",
    "/v1/messages",
    "/v1/responses/",
    "/v1/chat/completions",
    "/v1/completions",
    "/v1/models",
    "/messages",
    "/responses",
    "/chat/completions",
  ])("normalizes a root, version or full endpoint: %s", (path) => {
    expect(modelListUrl(protocol, `https://provider.example${path}`)).toBe(
      "https://provider.example/v1/models",
    );
  });

  it.each(["/v1", "/v1/messages", "/v1/responses", "/v1/chat/completions/"])(
    "preserves custom proxy prefixes: %s",
    (path) => {
      expect(
        modelListUrl(protocol, `https://proxy.example/gateway/team${path}`),
      ).toBe("https://proxy.example/gateway/team/v1/models");
    },
  );

  it("preserves the configured base and adds the protocol-specific models path", () => {
    expect(modelListUrl(protocol, "http://localhost:8080/proxy/team/")).toBe(
      `http://localhost:8080/proxy/team${protocol === "anthropic" ? "/v1" : ""}/models`,
    );
  });

  it("strips completion query parameters and fragments", () => {
    expect(
      modelListUrl(
        protocol,
        " https://provider.example/v1/responses?stream=true#fragment ",
      ),
    ).toBe("https://provider.example/v1/models");
  });

  it.each([
    "",
    "not a url",
    "/v1",
    "ftp://host",
    "file:///tmp/models",
    "wss://host",
    "https://user:pass@host",
  ])("rejects unsafe or invalid URLs: %s", (url) => {
    expect(modelListUrl(protocol, url)).toBeUndefined();
  });
});

describe("discoverModels", () => {
  it.each(protocols)(
    "uses %s authentication without redirecting credentials",
    async (protocol) => {
      await discoverModels({ ...connection, protocol });
      expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
        "https://provider.example/v1/models",
        {
          method: "GET",
          headers:
            protocol === "anthropic"
              ? {
                  Accept: "application/json",
                  "anthropic-version": "2023-06-01",
                  "x-api-key": "secret-key",
                }
              : {
                  Accept: "application/json",
                  Authorization: "Bearer secret-key",
                },
          redirect: "error",
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          signal: expect.any(AbortSignal),
        },
      );
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(protocols)(
    "does not inject environment credentials for %s",
    async (protocol) => {
      await discoverModels({ ...connection, protocol, api_key: "" });
      const headers = fetchMock.mock.calls[0]?.[1]?.headers;
      expect(headers).not.toHaveProperty("Authorization");
      expect(headers).not.toHaveProperty("x-api-key");
    },
  );

  it("validates model metadata, deduplicates IDs and ignores capability guesses", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        object: "list",
        data: [
          {
            id: " model-a ",
            display_name: "Friendly A",
            capabilities: ["thinking"],
          },
          { id: "model-b", name: "Friendly B" },
          { id: "model-a", display_name: "Duplicate" },
          { id: "unknown-model" },
        ],
      }),
    );
    await expect(discoverModels(connection)).resolves.toEqual([
      { id: "model-a", display_name: "Friendly A" },
      { id: "model-b", name: "Friendly B" },
      { id: "unknown-model" },
    ]);
  });

  it("accepts an empty model list", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ data: [], has_more: false, last_id: null }),
    );
    await expect(discoverModels(connection)).resolves.toEqual([]);
  });

  it.each([
    null,
    {},
    { data: null },
    { data: [{}] },
    { data: [{ id: 1 }] },
    { data: [{ id: "  " }] },
    { data: [{ id: "a", display_name: 1 }] },
    { data: [{ id: "a", name: null }] },
    { data: [], has_more: "true" },
    { data: [], last_id: 123 },
  ])(
    "rejects invalid boundary data without leaking its contents: %j",
    async (body) => {
      fetchMock.mockResolvedValue(Response.json(body));
      await expect(discoverModels(connection)).rejects.toThrow(
        "Model discovery failed",
      );
    },
  );

  it.each([301, 401, 403, 404, 500])(
    "does not read HTTP %s error bodies",
    async (status) => {
      const response = new Response("sensitive error body", { status });
      const json = vi.spyOn(response, "json");
      fetchMock.mockResolvedValue(response);
      await expect(discoverModels(connection)).rejects.toThrow(
        /^Model discovery failed$/,
      );
      expect(json).not.toHaveBeenCalled();
    },
  );

  it("sanitizes network and JSON errors", async () => {
    fetchMock.mockRejectedValueOnce(
      new Error("secret-key at https://private.example"),
    );
    await expect(discoverModels(connection)).rejects.toThrow(
      /^Model discovery failed$/,
    );
    fetchMock.mockResolvedValueOnce(
      new Response("not JSON containing secret-key"),
    );
    await expect(discoverModels(connection)).rejects.toThrow(
      /^Model discovery failed$/,
    );
  });

  it("rejects invalid URLs before fetching", async () => {
    await expect(
      discoverModels({ ...connection, base_url: "file:///tmp/private" }),
    ).rejects.toThrow("HTTP(S)");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("honors a signal aborted before the request", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      discoverModels(connection, controller.signal),
    ).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  function stallUntilAborted() {
    fetchMock.mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              reject(new Error("aborted"));
            },
            {
              once: true,
            },
          );
        }),
    );
  }

  it("cancels in-flight requests and removes the parent signal listener", async () => {
    stallUntilAborted();
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const result = expect(
      discoverModels(connection, controller.signal),
    ).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    await result;
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds the complete request with a timeout", async () => {
    stallUntilAborted();
    const result = expect(discoverModels(connection)).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await result;
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels during pagination without returning a partial catalog", async () => {
    stallUntilAborted();
    fetchMock.mockResolvedValueOnce(
      Response.json({
        data: [{ id: "a" }],
        has_more: true,
        last_id: "a",
      }),
    );
    const controller = new AbortController();
    const result = expect(
      discoverModels(connection, controller.signal),
    ).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    controller.abort();
    await result;
    expect(fetchMock.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("paginates Anthropic with encoded cursors and deduplicates across pages", async () => {
    fetchMock
      .mockResolvedValueOnce(
        Response.json({
          data: [{ id: "a" }],
          has_more: true,
          last_id: "a/b & c",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          data: [{ id: "a" }, { id: "b" }],
          has_more: true,
          last_id: "b",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ data: [{ id: "c" }], has_more: false, last_id: "c" }),
      );
    await expect(discoverModels(connection)).resolves.toEqual([
      { id: "a" },
      { id: "b" },
      { id: "c" },
    ]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://provider.example/v1/models",
      "https://provider.example/v1/models?after_id=a%2Fb+%26+c",
      "https://provider.example/v1/models?after_id=b",
    ]);
  });

  it.each([undefined, null, ""])(
    "rejects missing pagination cursors: %s",
    async (last_id) => {
      fetchMock.mockResolvedValue(
        Response.json({ data: [{ id: "a" }], has_more: true, last_id }),
      );
      await expect(discoverModels(connection)).rejects.toThrow(
        "Model discovery failed",
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("stops repeated cursors", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        Response.json({
          data: [{ id: "a" }],
          has_more: true,
          last_id: "a",
        }),
      ),
    );
    await expect(discoverModels(connection)).rejects.toThrow(
      "Model discovery failed",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("bounds pagination even when every cursor is different", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        Response.json({
          data: [],
          has_more: true,
          last_id: String(fetchMock.mock.calls.length),
        }),
      ),
    );
    await expect(discoverModels(connection)).rejects.toThrow(
      "Model discovery failed",
    );
    expect(fetchMock).toHaveBeenCalledTimes(10);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not apply Anthropic pagination to OpenAI catalogs", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ data: [{ id: "a" }], has_more: true, last_id: "a" }),
    );
    await expect(
      discoverModels({ ...connection, protocol: "openai" }),
    ).resolves.toEqual([{ id: "a" }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
