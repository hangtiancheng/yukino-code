import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { MCPOAuthConfig } from "@/mcp/config.js";
import { MCPOAuthCallback, MCPOAuthProvider } from "@/mcp/oauth.js";

const endpoint = "https://resource.example/mcp";
const issuer = "https://identity.example/";
const config: MCPOAuthConfig = {
  issuer,
  registration: "dynamic",
  callback: {
    mode: "headless",
    redirect_uri: "http://127.0.0.1:54321/callback",
  },
  scope: "tools",
};
const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function directory() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "yukino-mcp-oauth-"));
  dirs.push(dir);
  return dir;
}
function json(value: unknown) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}
function mockOAuth() {
  const tokenBodies: URLSearchParams[] = [];
  const fetchMock = vi.fn(
    (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(init?.redirect).toBe("error");
      if (url.hostname === "resource.example") {
        return Promise.resolve(
          json({ resource: endpoint, authorization_servers: [issuer] }),
        );
      }
      if (url.pathname.includes(".well-known")) {
        return Promise.resolve(
          json({
            issuer,
            authorization_endpoint: `${issuer}authorize`,
            token_endpoint: `${issuer}token`,
            registration_endpoint: `${issuer}register`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
          }),
        );
      }
      if (url.pathname === "/register") {
        return Promise.resolve(
          json({
            ...JSON.parse(typeof init?.body === "string" ? init.body : "{}"),
            client_id: "registered-by-sdk",
          }),
        );
      }
      if (url.pathname === "/token") {
        tokenBodies.push(
          new URLSearchParams(
            typeof init?.body === "string"
              ? init.body
              : init?.body instanceof URLSearchParams
                ? init.body
                : "",
          ),
        );
        return Promise.resolve(
          json({
            access_token: "private-access",
            refresh_token: "rotated-refresh",
            token_type: "Bearer",
            expires_in: 3600,
          }),
        );
      }
      throw new Error("Unexpected mock OAuth endpoint");
    },
  );
  return { fetchMock, tokenBodies };
}

describe("MCP OAuth SDK provider", () => {
  it("never initiates login or reuses an LLM credential implicitly", async () => {
    const fetchMock = vi.fn();
    const provider = new MCPOAuthProvider(endpoint, config, {
      tokenDirectory: await directory(),
      fetch: fetchMock,
    });
    await expect(provider.getAccessToken()).rejects.toThrow(
      "automatic login is disabled",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await provider.status()).authenticated).toBe(false);
  });
  it("uses SDK PKCE/state/DCR and privately stores target-bound tokens atomically", async () => {
    const dir = await directory();
    const { fetchMock, tokenBodies } = mockOAuth();
    const provider = new MCPOAuthProvider(endpoint, config, {
      tokenDirectory: dir,
      fetch: fetchMock,
    });
    let challenge = "";
    await provider.login({
      onAuthorization(url, submit) {
        expect(url.searchParams.get("code_challenge_method")).toBe("S256");
        expect(url.searchParams.get("resource")).toBe(endpoint);
        challenge = url.searchParams.get("code_challenge") ?? "";
        const callback = new URL(url.searchParams.get("redirect_uri") ?? "");
        callback.searchParams.set("state", url.searchParams.get("state") ?? "");
        callback.searchParams.set("code", "mock-code");
        submit(callback.href);
      },
    });
    expect(tokenBodies).toHaveLength(1);
    expect(tokenBodies[0].get("grant_type")).toBe("authorization_code");
    expect(
      createHash("sha256")
        .update(tokenBodies[0].get("code_verifier") ?? "")
        .digest("base64url"),
    ).toBe(challenge);
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    expect((await stat(path.join(dir, files[0]))).mode & 0o777).toBe(0o600);
    const raw = await readFile(path.join(dir, files[0]), "utf8");
    expect(raw).toContain("rotated-refresh");
    expect(raw).not.toContain("code_verifier");
    expect(await provider.getAccessToken()).toBe("private-access");
    const wrongTarget = new MCPOAuthProvider(
      "https://resource.example/other",
      { ...config, resource: "https://resource.example/other" },
      { tokenDirectory: dir, fetch: fetchMock },
    );
    await expect(wrongTarget.getAccessToken()).rejects.toThrow(
      "login required",
    );
    await provider.logout();
    expect(await readdir(dir)).toEqual([]);
  });
  it("uses registered clients without DCR and refreshes once with rotation", async () => {
    let now = 1000;
    const { fetchMock, tokenBodies } = mockOAuth();
    const provider = new MCPOAuthProvider(
      endpoint,
      { ...config, registration: "registered", client_id: "registered" },
      { tokenDirectory: await directory(), fetch: fetchMock, now: () => now },
    );
    await provider.saveTokens({
      access_token: "expired",
      refresh_token: "old-refresh",
      token_type: "Bearer",
      expires_in: 1,
      issuer,
    });
    now = 5000;
    const tokens = await Promise.all(
      Array.from({ length: 8 }, () => provider.getAccessToken()),
    );
    expect(new Set(tokens)).toEqual(new Set(["private-access"]));
    expect(tokenBodies).toHaveLength(1);
    expect(tokenBodies[0].get("grant_type")).toBe("refresh_token");
    expect(tokenBodies[0].get("refresh_token")).toBe("old-refresh");
    expect((await provider.tokens())?.refresh_token).toBe("rotated-refresh");
    expect(
      fetchMock.mock.calls.some(([url]) =>
        (url instanceof Request ? url.url : url.toString()).endsWith(
          "register",
        ),
      ),
    ).toBe(false);
  });
  it("binds issuer/audience/redirect and never follows credential redirects", async () => {
    const { fetchMock } = mockOAuth();
    const provider = new MCPOAuthProvider(endpoint, config, {
      tokenDirectory: await directory(),
      fetch: fetchMock,
    });
    await expect(
      provider.saveTokens({
        access_token: "secret",
        token_type: "Bearer",
        issuer: "https://evil.example/",
      }),
    ).rejects.toThrow("issuer mismatch");
    await expect(
      provider.validateResourceURL(endpoint, "https://evil.example/"),
    ).rejects.toThrow("resource mismatch");
    await provider.saveTokens({
      access_token: "secret",
      token_type: "Bearer",
      issuer,
    });
    await expect(
      provider.transportFetch("https://resource.example/other", {}),
    ).rejects.toThrow("endpoint mismatch");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      () =>
        new MCPOAuthProvider(
          endpoint,
          { ...config, resource: "https://evil.example/" },
          { tokenDirectory: "/tmp/private" },
        ),
    ).toThrow("audience");
  });
  it("cancels a pending headless callback and clears the ephemeral verifier", async () => {
    const { fetchMock } = mockOAuth();
    const provider = new MCPOAuthProvider(endpoint, config, {
      tokenDirectory: await directory(),
      fetch: fetchMock,
    });
    const controller = new AbortController();
    await expect(
      provider.login({
        signal: controller.signal,
        onAuthorization() {
          controller.abort();
        },
      }),
    ).rejects.toThrow("cancelled");
    expect(() => provider.codeVerifier()).toThrow("unavailable");
    expect((await provider.status()).authenticated).toBe(false);
  });
});

describe("one-shot OAuth callbacks", () => {
  it("rejects wrong state/target, accepts once, and enforces TTL/cancellation", async () => {
    vi.useFakeTimers();
    const callback = new MCPOAuthCallback(
      new URL("http://127.0.0.1:54321/callback"),
      new URL(issuer),
      undefined,
      100,
    );
    expect(() => {
      callback.accept("http://127.0.0.1:54321/callback?state=wrong&code=x");
    }).toThrow("state mismatch");
    expect(() => {
      callback.accept(
        `http://127.0.0.1:54321/other?state=${callback.state}&code=x`,
      );
    }).toThrow("redirect mismatch");
    callback.accept(
      `http://127.0.0.1:54321/callback?state=${callback.state}&code=x`,
    );
    expect(await callback.code).toBe("x");
    expect(() => {
      callback.accept(
        `http://127.0.0.1:54321/callback?state=${callback.state}&code=x`,
      );
    }).toThrow("already consumed");
    const expired = new MCPOAuthCallback(
      new URL("http://127.0.0.1:54321/callback"),
      new URL(issuer),
      undefined,
      100,
    );
    const rejection = expect(expired.code).rejects.toThrow("expired");
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    const controller = new AbortController();
    const cancelled = new MCPOAuthCallback(
      new URL("http://127.0.0.1:54321/callback"),
      new URL(issuer),
      controller.signal,
    );
    controller.abort();
    await expect(cancelled.code).rejects.toThrow("cancelled");
  });
});
