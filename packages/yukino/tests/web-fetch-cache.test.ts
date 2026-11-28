import { afterEach, describe, expect, it, vi } from "vitest";

import type * as Constants from "@/tools/constants.js";
import { WebFetchTool } from "@/tools/web-fetch.js";

vi.mock("@/tools/constants.js", async (importOriginal) => ({
  ...(await importOriginal<typeof Constants>()),
  MAX_CACHE_SIZE_BYTES: 400,
  CACHE_TTL_MS: 100,
}));

afterEach(() => vi.unstubAllGlobals());

function setup() {
  const fetcher = vi.fn(() =>
    Promise.resolve(
      new Response("x".repeat(100), {
        headers: { "content-type": "text/markdown" },
      }),
    ),
  );
  vi.stubGlobal("fetch", fetcher);
  const tool = new WebFetchTool();
  return {
    fetcher,
    get: (url: string, abortSignal?: AbortSignal) =>
      tool.execute({ cwd: process.cwd(), abortSignal }, { url }),
  };
}

describe("WebFetch cache", () => {
  it("retains recently read entries when its byte budget evicts older pages", async () => {
    const { fetcher, get } = setup();
    await get("https://cache.test/a");
    await get("https://cache.test/b");
    await get("https://cache.test/a");
    expect(fetcher).toHaveBeenCalledTimes(2);
    await get("https://cache.test/c");
    await get("https://cache.test/a");
    expect(fetcher).toHaveBeenCalledTimes(3);
    await get("https://cache.test/b");
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("refetches expired pages and rejects cancellation even on a cache hit", async () => {
    const { fetcher, get } = setup();
    const url = "https://cache.test/ttl";
    await get(url);
    await get(url);
    expect(fetcher).toHaveBeenCalledOnce();
    const controller = new AbortController();
    controller.abort();
    expect((await get(url, controller.signal)).isError).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
    await new Promise((resolve) => setTimeout(resolve, 130));
    await get(url);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
