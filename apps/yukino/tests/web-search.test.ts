import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { extractContent, PermissionChecker } from "@/permissions/index.js";
import { parseBingSearch } from "@/tools/bing-search.js";
import { WebSearchTool } from "@/tools/web-search.js";

const fixture = readFileSync(
  new URL("./fixtures/bing-search.html", import.meta.url),
  "utf8",
);
const cwd = "/private/workspace";

function page(blocks: string): string {
  return `<ol id="b_results">${blocks}</ol>`;
}

function block(url: string, title = "A source", snippet = "Evidence"): string {
  const href = url.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  return `<li class="b_algo"><h2><a href="${href}">${title}</a></h2><div class="b_caption"><p>${snippet}</p></div></li>`;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Bing result parsing", () => {
  it("reads organic results, decodes entities and redirects, and excludes ads, scripts, and duplicates", async () => {
    expect(await parseBingSearch(fixture)).toEqual([
      {
        title: "Current & 🙂 docs",
        url: "https://docs.example.com/guide?a=1&b=2",
        snippet: 'Useful documentation "today".',
      },
      {
        title: "TypeScript: JavaScript With Syntax For Types.",
        url: "https://www.typescriptlang.org/",
        snippet: "TypeScript builds on JavaScript.",
      },
      {
        title: "Deceptive",
        url: "https://example.com.evil.test/a",
        snippet: "Wrong domain",
      },
    ]);
  });

  it("validates redirects and rejects internal, malformed, credential-bearing, and non-web URLs", async () => {
    const urls = [
      "https://www.bing.com/videos",
      "/search?q=other",
      "#anchor",
      "javascript:alert(1)",
      "file:///tmp/secret",
      "https://user:password@example.com/",
      "https://www.bing.com/ck/a?u=broken",
      "https://www.bing.com/ck/a?u=a1" +
        Buffer.from("file:///tmp/secret").toString("base64url"),
      "https://www.bing.com/ck/a?u=a1" +
        Buffer.from("https://www.bing.com/search").toString("base64url"),
      "https://www.bing.com/ck/a?u=a1" +
        Buffer.from("https://example.com/?x=1&y=2").toString("base64url"),
      "https://notbing.com/?u=ordinary-query",
      "//external.test/a",
    ];
    expect(
      (await parseBingSearch(page(urls.map((url) => block(url)).join("")))).map(
        (result) => result.url,
      ),
    ).toEqual([
      "https://example.com/?x=1&y=2",
      "https://notbing.com/?u=ordinary-query",
      "https://external.test/a",
    ]);
  });

  it("reports explicit empty results and keeps markup failures distinct", async () => {
    expect(
      await parseBingSearch(page('<li class="b_no">No results found.</li>')),
    ).toEqual([]);
    await expect(
      parseBingSearch('<div id="b_captcha">Verify</div>'),
    ).rejects.toThrow("CAPTCHA");
    await expect(parseBingSearch("<html>Blocked</html>")).rejects.toThrow(
      "Could not read Bing",
    );
    await expect(
      parseBingSearch(page(block("javascript:alert(1)"))),
    ).rejects.toThrow("Could not read Bing");
  });
});

describe("WebSearch", () => {
  it("searches Bing without API keys or session, model, or workspace metadata", async () => {
    vi.stubEnv("EXA_API_KEY", "unused-secret");
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(fixture));
    vi.stubGlobal("fetch", fetch);
    const result = await new WebSearchTool().execute(
      { cwd, sessionId: "private-session" },
      { query: "current docs & example=🙂", num_results: 2 },
    );
    expect(result.isError).toBe(false);
    expect(result.output).toContain("https://www.typescriptlang.org/");
    expect(result.output).not.toContain("Deceptive");
    expect(result.output).not.toContain("unused-secret");
    const [input, request] = fetch.mock.calls[0];
    if (!(input instanceof URL)) {
      throw new TypeError("Expected a URL request");
    }
    const url = input;
    expect(url.origin + url.pathname).toBe("https://www.bing.com/search");
    expect([...url.searchParams]).toEqual([
      ["q", "current docs & example=🙂"],
      ["count", "2"],
      ["setmkt", "en-US"],
    ]);
    expect(request?.body).toBeUndefined();
    expect(JSON.stringify(request)).not.toContain("unused-secret");
    expect(JSON.stringify(request)).not.toContain("private");
    expect(
      new WebSearchTool().schema().input_schema.properties,
    ).not.toHaveProperty("type");
  });

  it("preserves exact-host and subdomain filtering before applying the result count", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(fixture))),
    );
    const tool = new WebSearchTool();
    const allowed = await tool.execute(
      { cwd },
      {
        query: "docs",
        allowed_domains: [" EXAMPLE.COM. "],
        num_results: 1,
      },
    );
    expect(allowed.isError).toBe(false);
    expect(allowed.output).toContain("Useful documentation");
    expect(allowed.output).not.toContain("Deceptive");
    const blocked = await tool.execute(
      { cwd },
      {
        query: "docs",
        blocked_domains: ["example.com"],
        num_results: 1,
      },
    );
    expect(blocked.output).toContain("https://www.typescriptlang.org/");
    expect(blocked.output).not.toContain("docs.example.com");
    expect(
      (
        await tool.execute(
          { cwd },
          {
            query: "docs",
            allowed_domains: ["missing.test"],
          },
        )
      ).output,
    ).toBe("No search results match the domain filter.");
  });

  it("handles fragmented UTF-8 without changing titles or snippets", async () => {
    const bytes = new TextEncoder().encode(fixture);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 7) {
          controller.enqueue(bytes.subarray(i, i + 7));
        }
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(stream)),
    );
    const result = await new WebSearchTool().execute(
      { cwd },
      { query: "docs" },
    );
    expect(result.isError).toBe(false);
    expect(result.output).toContain("Current & 🙂 docs");
    expect(stream.locked).toBe(false);
  });

  it.each([
    { query: " " },
    { query: "x".repeat(4001) },
    { query: "x", num_results: 0 },
    { query: "x", num_results: 21 },
    { query: "x", num_results: 1.5 },
    { query: "x", type: "auto" },
    {
      query: "x",
      allowed_domains: ["example.com"],
      blocked_domains: ["other.test"],
    },
    ...[
      "https://example.com",
      "example.com/path",
      "example.com:8080",
      "user@example.com",
      "*.example.com",
    ].map((domain) => ({ query: "x", allowed_domains: [domain] })),
  ])(
    "rejects invalid or removed arguments without sending requests: %j",
    async (args) => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      expect((await new WebSearchTool().execute({ cwd }, args)).isError).toBe(
        true,
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("does not start requests after cancellation and propagates the caller's signal", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(fixture));
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    controller.abort();
    expect(
      (
        await new WebSearchTool().execute(
          { cwd, abortSignal: controller.signal },
          { query: "q" },
        )
      ).isError,
    ).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    const running = new AbortController();
    await new WebSearchTool().execute(
      { cwd, abortSignal: running.signal },
      { query: "q" },
    );
    const signal = fetch.mock.calls[0][1]?.signal;
    expect(signal?.aborted).toBe(false);
    running.abort();
    expect(signal?.aborted).toBe(true);
  });

  it("cancels and unlocks the response when interrupted during streaming", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              pull(stream) {
                stream.enqueue(new TextEncoder().encode("<html>"));
                controller.abort();
              },
              cancel,
            }),
          ),
        ),
      ),
    );
    expect(
      (
        await new WebSearchTool().execute(
          { cwd, abortSignal: controller.signal },
          { query: "q" },
        )
      ).isError,
    ).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    { status: 429 },
    { headers: { "Content-Type": "image/png" } },
    { headers: { "Content-Length": String(2 * 1024 * 1024 + 1) } },
  ])("cancels rejected bodies before reading: %j", async (init) => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(body, init)),
    );
    expect(
      (await new WebSearchTool().execute({ cwd }, { query: "q" })).isError,
    ).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("enforces the byte limit while streaming even without Content-Length", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
      },
      cancel,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(body)),
    );
    const result = await new WebSearchTool().execute({ cwd }, { query: "q" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("2 MiB");
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("bounds model output without executing fetched scripts", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(
            page(block("https://example.com/", "Title", "x".repeat(150000))),
          ),
        ),
    );
    const result = await new WebSearchTool().execute({ cwd }, { query: "q" });
    expect(result.isError).toBe(false);
    expect(result.output.length).toBeLessThan(100100);
    expect(result.output).toContain("[Truncated;");
  });

  it("returns empty searches as success and network failures as errors without fallback", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(page('<li class="b_no">No results.</li>')),
      )
      .mockRejectedValueOnce(new Error("network unavailable"));
    vi.stubGlobal("fetch", fetch);
    expect(await new WebSearchTool().execute({ cwd }, { query: "q" })).toEqual({
      output: "No search results found.",
      isError: false,
    });
    expect(await new WebSearchTool().execute({ cwd }, { query: "q" })).toEqual({
      output: "Error: network unavailable",
      isError: true,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("uses explicit permission content for read-only tools", () => {
    expect(extractContent("WebSearch", { query: "private query" })).toBe(
      "private query",
    );
    expect(extractContent("LSP", { file_path: "example.ts" })).toBe(
      "example.ts",
    );
    const checker = new PermissionChecker("/tmp", "default");
    expect(checker.check("WebSearch", "read", { query: "docs" }).effect).toBe(
      "allow",
    );
  });
});
