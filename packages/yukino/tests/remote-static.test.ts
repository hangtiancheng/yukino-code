import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type * as Constants from "@/remote/constants.js";
import type { RemoteServer } from "@/remote/server.js";

let directory: string;
let server: RemoteServer;
let running: Promise<void>;
let origin: string;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "yukino-static-"));
  const root = join(directory, "public");
  mkdirSync(root);
  writeFileSync(join(root, "index.html"), "<main>Yukino</main>");
  writeFileSync(join(root, "app.js"), "const ready = true;");
  writeFileSync(join(root, ".secret"), "PRIVATE");
  writeFileSync(join(directory, "outside.txt"), "OUTSIDE");
  vi.doMock("@/remote/constants.js", async (importOriginal) => ({
    ...(await importOriginal<typeof Constants>()),
    BROWSER_DIST: root,
  }));
  const { RemoteServer } = await import("@/remote/server.js");
  server = new RemoteServer({
    providers: [],
    addr: "127.0.0.1:0",
    enableCoordinatorMode: false,
  });
  running = server.run();
  const http: unknown = Reflect.get(server, "server");
  if (!(http instanceof Server)) {
    throw new Error("Missing HTTP server");
  }
  await vi.waitFor(() => {
    expect(http.listening).toBe(true);
  });
  const address = http.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing HTTP address");
  }
  origin = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(async () => {
  await server?.stop();
  await running;
  vi.doUnmock("@/remote/constants.js");
  rmSync(directory, { recursive: true, force: true });
});

describe("remote static files", () => {
  it("serves MIME types, HEAD, ranges and conditional requests through Express", async () => {
    const response = await fetch(`${origin}/app.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("javascript");
    expect(await response.text()).toBe("const ready = true;");
    const etag = response.headers.get("etag");
    expect(etag).toBeTruthy();
    const unchanged = await fetch(`${origin}/app.js`, {
      headers: { "if-none-match": etag ?? "", "cache-control": "max-age=0" },
    });
    expect(unchanged.status).toBe(304);
    const head = await fetch(`${origin}/app.js`, { method: "HEAD" });
    expect(head.headers.get("content-length")).toBe("19");
    expect(await head.text()).toBe("");
    const partial = await fetch(`${origin}/app.js`, {
      headers: { range: "bytes=0-4" },
    });
    expect(partial.status).toBe(206);
    expect(await partial.text()).toBe("const");
  });

  it("keeps SPA routes while denying dotfiles and paths outside the bundle", async () => {
    const page = await fetch(`${origin}/sessions/example`);
    expect(await page.text()).toBe("<main>Yukino</main>");
    const hidden = await fetch(`${origin}/.secret`);
    expect(await hidden.text()).not.toContain("PRIVATE");
    const outside = await fetch(`${origin}/%2e%2e%2foutside.txt`);
    expect(await outside.text()).not.toContain("OUTSIDE");
  });
});
