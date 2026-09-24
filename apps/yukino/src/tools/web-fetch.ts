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

import type TurndownService from "turndown";

import { WEB_FETCH_DESCRIPTION } from "./descriptions.js";
import type {
  Tool,
  ToolCategory,
  ToolContext,
  ToolResult,
  ToolSchema,
} from "./types.js";

import { createChildLogger } from "@/logger/index.js";
import { asErrorString, strArg } from "@/utils/index.js";
// import { version } from "@/version.js";

const log = createChildLogger({ module: "tools" });

// Resource controls: cap a single response, the request timeout, and how much
// markdown reaches the model, so one fetch cannot overwhelm the session.
const MAX_CONTENT_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 60_000;
const MAX_MARKDOWN_LENGTH = 100_000;

// Fetched pages are cached per URL for 15 minutes (expired entries are dropped
// on access), bounded by a 50MB byte budget with oldest-first eviction.
const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_CACHE_SIZE_BYTES = 50 * 1024 * 1024;

interface CacheEntry {
  markdown: string;
  finalUrl: string;
  expiresAt: number;
  size: number;
}

const urlCache = new Map<string, CacheEntry>();
let urlCacheBytes = 0;

function cacheGet(url: string): CacheEntry | undefined {
  const entry = urlCache.get(url);
  if (!entry) {
    return undefined;
  }
  if (entry.expiresAt <= Date.now()) {
    urlCache.delete(url);
    urlCacheBytes -= entry.size;
    return undefined;
  }
  return entry;
}

function cacheSet(url: string, markdown: string, finalUrl: string): void {
  const existing = urlCache.get(url);
  if (existing) {
    urlCacheBytes -= existing.size;
  }
  const size = Math.max(1, Buffer.byteLength(markdown));
  urlCache.set(url, {
    markdown,
    finalUrl,
    expiresAt: Date.now() + CACHE_TTL_MS,
    size,
  });
  urlCacheBytes += size;
  // Map iterates in insertion order; drop oldest entries until under budget.
  for (const key of urlCache.keys()) {
    if (urlCacheBytes <= MAX_CACHE_SIZE_BYTES) {
      break;
    }
    const evicted = urlCache.get(key);
    urlCache.delete(key);
    if (evicted) {
      urlCacheBytes -= evicted.size;
    }
  }
}

// Lazy singleton — defers the turndown → @mixmark-io/domino import (~1.4MB
// retained heap) until the first HTML fetch, and reuses one instance across
// calls (construction builds the rule set; .turndown() itself is stateless).
// The top-level `import type` is erased at compile time, so it does not
// defeat the lazy load; at runtime Node's CJS interop exposes the class as
// the module's default export.
let turndownServicePromise: Promise<TurndownService> | undefined;
function getTurndownService(): Promise<TurndownService> {
  return (turndownServicePromise ??= import("turndown").then(
    // Strip <script>/<style>: turndown's default rules keep their text content,
    // which pollutes the markdown with JS/CSS noise.
    (mod) => new mod.default().remove(["script", "style"]),
  ));
}

// Text/binary split: everything under text/ plus the structured text formats
// served as application/. Suffix and exact matches keep 'openxmlformats'
// (docx/xlsx) on the binary side.
function isBinaryContentType(contentType: string): boolean {
  if (!contentType) {
    return false;
  }
  const mt = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  if (mt.startsWith("text/")) {
    return false;
  }
  if (mt.endsWith("+json") || mt === "application/json") {
    return false;
  }
  if (mt.endsWith("+xml") || mt === "application/xml") {
    return false;
  }
  if (mt.startsWith("application/javascript")) {
    return false;
  }
  if (mt === "application/x-www-form-urlencoded") {
    return false;
  }
  return true;
}

function truncateMarkdown(content: string): string {
  if (content.length <= MAX_MARKDOWN_LENGTH) {
    return content;
  }
  return `${content.slice(0, MAX_MARKDOWN_LENGTH)}\n\n[Content truncated due to length...]`;
}

function formatResult(
  markdown: string,
  requestedUrl: string,
  finalUrl: string,
): string {
  const content = truncateMarkdown(markdown);
  // Redirects are followed automatically, so surface the final URL when it
  // differs from the request — the content may reference it.
  if (finalUrl && finalUrl !== requestedUrl) {
    return `[Redirected to ${finalUrl}]\n\n${content}`;
  }
  return content;
}

export class WebFetchTool implements Tool {
  // Use a hardcoded string instead of WebFetchTool.name.replace("Tool", "")
  // because class names are not stable after minification — bundlers like
  // Terser/esbuild may rename or mangle them, producing incorrect tool names at runtime.
  name = "WebFetch";
  description = WEB_FETCH_DESCRIPTION;
  category: ToolCategory = "read";

  schema(): ToolSchema {
    const inputSchema = {
      type: "object" as const,
      properties: {
        url: {
          type: "string" as const,
          description: "The http or https URL to fetch content from.",
        },
      },
      required: ["url"],
    };

    return {
      name: this.name,
      description: this.description,
      input_schema: inputSchema,
    };
  }

  async execute(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const url = strArg(args, "url");
    if (!url) {
      return { output: "Error: url is required", isError: true };
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { output: `Error: invalid URL "${url}"`, isError: true };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        output: `Error: unsupported protocol "${parsed.protocol}" — only http and https URLs can be fetched`,
        isError: true,
      };
    }

    const cached = cacheGet(url);
    if (cached) {
      return {
        output: formatResult(cached.markdown, url, cached.finalUrl),
        isError: false,
      };
    }

    const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const signal = ctx.abortSignal
      ? AbortSignal.any([ctx.abortSignal, timeoutSignal])
      : timeoutSignal;

    let response: Response;
    try {
      response = await fetch(url, {
        signal,
        redirect: "follow",
        headers: {
          Accept: "text/markdown, text/html, */*",
          // "User-Agent": `yukino/${version}`,
        },
      });
    } catch (err) {
      log.error({ err, url }, "web fetch failed");
      return {
        output: `Error: fetch failed: ${asErrorString(err)}`,
        isError: true,
      };
    }

    if (!response.ok) {
      return {
        output: `Error: HTTP ${String(response.status)} ${response.statusText} for ${url}`,
        isError: true,
      };
    }

    const declaredBytes = Number.parseInt(
      response.headers.get("content-length") ?? "",
      10,
    );
    if (!Number.isNaN(declaredBytes) && declaredBytes > MAX_CONTENT_BYTES) {
      return {
        output: `Error: response is ${String(declaredBytes)} bytes, over the ${String(MAX_CONTENT_BYTES)}-byte limit`,
        isError: true,
      };
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (isBinaryContentType(contentType)) {
      return {
        output: `Error: binary content (${contentType}) is not supported; only text content can be fetched`,
        isError: true,
      };
    }

    let body: ArrayBuffer;
    try {
      body = await response.arrayBuffer();
    } catch (err) {
      log.error({ err, url }, "reading response body failed");
      return {
        output: `Error: reading response body failed: ${asErrorString(err)}`,
        isError: true,
      };
    }
    if (body.byteLength > MAX_CONTENT_BYTES) {
      return {
        output: `Error: response is ${String(body.byteLength)} bytes, over the ${String(MAX_CONTENT_BYTES)}-byte limit`,
        isError: true,
      };
    }

    const raw = Buffer.from(body).toString("utf-8");
    let markdown: string;
    try {
      markdown = contentType.includes("text/html")
        ? (await getTurndownService()).turndown(raw)
        : raw;
    } catch (err) {
      log.error({ err, url }, "HTML to Markdown conversion failed");
      return {
        output: `Error: HTML to Markdown conversion failed: ${asErrorString(err)}`,
        isError: true,
      };
    }

    const finalUrl = response.url || url;
    cacheSet(url, markdown, finalUrl);
    return { output: formatResult(markdown, url, finalUrl), isError: false };
  }
}
