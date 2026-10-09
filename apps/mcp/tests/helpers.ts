// Shared test helpers for the MCP tool suites.

import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, vi } from "vitest";
import { z } from "zod";

const TextContentSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

/** The text of the first content block, asserting it is a TextContent. */
export function firstText(result: { content: unknown }): string {
  const content = z.array(z.unknown()).parse(result.content);
  return TextContentSchema.parse(content[0]).text;
}

/** A fresh temporary directory. */
export function makeTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "yukino-mcp-test-"));
}

/** A fake `gh` executable whose behaviour is the given sh script body. */
export function writeFakeGh(dir: string, script: string): string {
  const gh = path.join(dir, "gh");
  writeFileSync(gh, `#!/bin/sh\n${script}\n`, { encoding: "utf-8" });
  chmodSync(gh, 0o755);
  return gh;
}

/**
 * Snapshot/restore the given process.env keys around every test, so env
 * mutations (PATH, GITHUB_TOKEN, ...) never leak between tests or into the
 * developer's environment.
 */
export function isolateEnv(keys: string[]): void {
  const saved = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const key of keys) {
      saved.set(key, process.env[key]);
    }
  });
  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
    saved.clear();
    vi.unstubAllGlobals();
  });
}

/** One fetch call as recorded by stubFetchRoutes. */
export interface RecordedFetch {
  method: string;
  /** Full request URL. */
  url: string;
  /** URL without the query string (what routes match against). */
  baseUrl: string;
  searchParams: Record<string, string>;
  headers: Record<string, string>;
  /** Request body when it was a string (JSON payloads), else null. */
  body: string | null;
}

export interface FetchRoute {
  method: string;
  /** Matched against the request URL without query string. */
  url: string;
  status?: number;
  json?: unknown;
  /** Raw text body; mutually exclusive with json. */
  text?: string;
  headers?: Record<string, string>;
}

export interface FetchStub {
  calls: RecordedFetch[];
  /** The last recorded call (throws when there was none). */
  lastCall(): RecordedFetch;
}

/**
 * Route-based global fetch stub: matches on method + URL-without-query and
 * answers with the canned payload; unmatched requests answer 404 so no test
 * can reach the real network.
 */
export function stubFetchRoutes(routes: FetchRoute[]): FetchStub {
  const calls: RecordedFetch[] = [];
  const fetchStub = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const parsed = new URL(url);
    const headers = new Headers(init?.headers);
    const rawBody = init?.body;
    const recorded: RecordedFetch = {
      method: (init?.method ?? "GET").toUpperCase(),
      url,
      baseUrl: `${parsed.origin}${parsed.pathname}`,
      searchParams: Object.fromEntries(parsed.searchParams.entries()),
      headers: Object.fromEntries(headers.entries()),
      body: typeof rawBody === "string" ? rawBody : null,
    };
    calls.push(recorded);

    const route = routes.find(
      (candidate) =>
        candidate.method.toUpperCase() === recorded.method &&
        candidate.url === recorded.baseUrl,
    );
    if (route === undefined) {
      return Response.json(
        {
          message: `no fetch route for ${recorded.method} ${recorded.baseUrl}`,
        },
        { status: 404 },
      );
    }
    const status = route.status ?? 200;
    const body =
      route.text !== undefined
        ? route.text
        : route.json !== undefined
          ? JSON.stringify(route.json)
          : null;
    return new Response(body, {
      status,
      headers: {
        ...(body !== null ? { "content-type": "application/json" } : {}),
        ...route.headers,
      },
    });
  };
  vi.stubGlobal("fetch", fetchStub);
  return {
    calls,
    lastCall(): RecordedFetch {
      const last = calls.at(-1);
      if (last === undefined) {
        throw new Error("expected at least one fetch call");
      }
      return last;
    },
  };
}
