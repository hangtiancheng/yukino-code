import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MCPClient } from "@/mcp/client.js";
import {
  MCPConnectionError,
  isOptionalMCPConnectionError,
} from "@/mcp/errors.js";
import { MCPOAuthProvider } from "@/mcp/oauth.js";

function client() {
  vi.spyOn(Client.prototype, "close").mockResolvedValue();
  return new MCPClient({
    name: "private-server",
    url: "https://example.invalid/mcp?token=query-secret",
    headers: { Authorization: "Bearer header-secret" },
    env: { TOKEN: "env-secret" },
  });
}

async function connectionFailure(
  connection: MCPClient,
): Promise<MCPConnectionError> {
  const error: unknown = await connection
    .connect({ timeoutMs: 1000 })
    .catch((error: unknown) => error);
  expect(error).toBeInstanceOf(MCPConnectionError);
  if (!(error instanceof MCPConnectionError)) {
    throw new Error("Missing diagnostic");
  }
  return error;
}

afterEach(() => vi.restoreAllMocks());

describe("offline MCP transport boundaries", () => {
  it("preserves HTTP fetch errors across SDK wrapping", async () => {
    const original = Object.assign(new Error("transport-secret"), {
      code: "ECONNREFUSED",
    });
    const transportFetch = vi.fn().mockRejectedValue(original);
    const error = await connectionFailure(
      new MCPClient(
        {
          name: "server",
          url: "https://example.invalid/mcp?token=url-secret",
          headers: { Authorization: "Bearer header-secret" },
        },
        false,
        { fetch: transportFetch },
      ),
    );
    expect(error.cause).toBe(original);
    expect(error.diagnostic).toMatchObject({
      transport: "http",
      phase: "connect",
      code: "ECONNREFUSED",
    });
    expect(isOptionalMCPConnectionError(error)).toBe(true);
    expect(JSON.stringify(error.diagnostic)).not.toContain("secret");
  });

  it.each([401, 403, 503, 400, 404])(
    "reports HTTP %i without response bodies or headers",
    async (status) => {
      const transportFetch = vi.fn().mockResolvedValue(
        new Response("body-secret", {
          status,
          statusText: "status-secret",
          headers: { "x-secret": "header-secret" },
        }),
      );
      const error = await connectionFailure(
        new MCPClient(
          { name: "server", url: "https://example.invalid/mcp" },
          false,
          { fetch: transportFetch },
        ),
      );
      expect(error.diagnostic.httpStatus).toBe(status);
      expect(isOptionalMCPConnectionError(error)).toBe(
        [401, 403, 503].includes(status),
      );
      expect(JSON.stringify(error)).not.toContain("secret");
    },
  );

  it("does not downgrade forbidden HTTP redirects to optional failures", async () => {
    const transportFetch = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { Location: "https://unauthorized.invalid/?token=secret" },
      }),
    );
    const error = await connectionFailure(
      new MCPClient(
        { name: "server", url: "https://example.invalid/mcp" },
        false,
        { fetch: transportFetch },
      ),
    );
    expect(isOptionalMCPConnectionError(error)).toBe(false);
    expect(JSON.stringify(error)).not.toContain("secret");
    expect(transportFetch).toHaveBeenCalledTimes(1);
  });

  it("represents missing host OAuth credentials without initiating login", async () => {
    const config = { issuer: "https://issuer.invalid", client_id: "client" };
    const oauth = new MCPOAuthProvider("https://example.invalid/mcp", config, {
      tokenDirectory: "/tmp/unused-mcp-credentials",
    });
    vi.spyOn(oauth, "tokens").mockResolvedValue(undefined);
    const login = vi.spyOn(oauth, "login");
    const transportFetch = vi.spyOn(oauth, "getAccessToken");
    const error = await connectionFailure(
      new MCPClient(
        { name: "server", url: "https://example.invalid/mcp", oauth: config },
        false,
        { oauth },
      ),
    );
    expect(error.diagnostic).toMatchObject({
      code: "AUTH_REQUIRED",
      httpStatus: 401,
    });
    expect(isOptionalMCPConnectionError(error)).toBe(true);
    expect(login).not.toHaveBeenCalled();
    expect(transportFetch).not.toHaveBeenCalled();
  });

  it("reports stdio EOF during the handshake as a typed unavailable failure", async () => {
    vi.spyOn(StdioClientTransport.prototype, "start").mockResolvedValue();
    vi.spyOn(StdioClientTransport.prototype, "send").mockImplementation(
      function (this: StdioClientTransport) {
        this.onclose?.();
        return Promise.resolve();
      },
    );
    const error = await connectionFailure(
      new MCPClient({ name: "stdio", command: "never-spawned" }),
    );
    expect(error.diagnostic).toMatchObject({
      transport: "stdio",
      code: "CONNECTION_CLOSED",
    });
    expect(isOptionalMCPConnectionError(error)).toBe(true);
  });
});

describe("MCP connection diagnostics", () => {
  it("preserves the handshake cause without exposing transport text or configuration", async () => {
    const original = Object.assign(
      new Error("query-secret header-secret env-secret response-secret"),
      { code: "ECONNREFUSED" },
    );
    vi.spyOn(Client.prototype, "connect").mockRejectedValue(original);
    const connection = client();
    const error: unknown = await connection
      .connect()
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(MCPConnectionError);
    if (!(error instanceof MCPConnectionError)) {
      throw new Error("Missing diagnostic");
    }
    expect(error.cause).toBe(original);
    expect(error.diagnostic).toEqual({
      serverName: "private-server",
      transport: "http",
      phase: "connect",
      code: "ECONNREFUSED",
      message: "MCP transport is unavailable",
    });
    expect(isOptionalMCPConnectionError(error)).toBe(true);
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toMatch(/secret/);
  });

  it("keeps the primary error even if disconnect rejects", async () => {
    const original = new McpError(
      ErrorCode.ConnectionClosed,
      "credential-secret",
    );
    vi.spyOn(Client.prototype, "connect").mockRejectedValue(original);
    const connection = client();
    vi.spyOn(connection, "disconnect").mockRejectedValue(
      new Error("cleanup-secret"),
    );
    await expect(connection.connect()).rejects.toMatchObject({
      cause: original,
      diagnostic: { code: "CONNECTION_CLOSED", phase: "connect" },
    });
  });

  it.each([
    [new UnauthorizedError("auth-secret"), "AUTH_REQUIRED", 401, true],
    [new StreamableHTTPError(503, "body-secret"), undefined, 503, true],
    [new StreamableHTTPError(400, "body-secret"), undefined, 400, false],
    [new StreamableHTTPError(999, "body-secret"), undefined, undefined, false],
    [
      new DOMException("timeout-secret", "TimeoutError"),
      "TIMEOUT",
      undefined,
      true,
    ],
    [
      new McpError(ErrorCode.RequestTimeout, "timeout-secret"),
      "TIMEOUT",
      undefined,
      true,
    ],
    [
      Object.assign(new Error("secret"), { code: "Bearer secret" }),
      undefined,
      undefined,
      false,
    ],
    [new Error("ECONNREFUSED timeout EOF secret"), undefined, undefined, false],
  ])(
    "only recognizes bounded typed transport details (%s)",
    async (original, code, httpStatus, optional) => {
      vi.spyOn(Client.prototype, "connect").mockRejectedValue(original);
      const error: unknown = await client()
        .connect()
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(MCPConnectionError);
      if (!(error instanceof MCPConnectionError)) {
        throw new Error("Missing diagnostic");
      }
      expect(error.cause).toBe(original);
      expect(error.diagnostic.code).toBe(code);
      expect(error.diagnostic.httpStatus).toBe(httpStatus);
      expect(isOptionalMCPConnectionError(error)).toBe(optional);
      expect(JSON.stringify(error.diagnostic)).not.toContain("secret");
    },
  );

  it("recognizes a native fetch network cause without discarding its original wrapper", async () => {
    const original = new TypeError("fetch-secret", {
      cause: Object.assign(new Error("socket-secret"), { code: "ECONNRESET" }),
    });
    vi.spyOn(Client.prototype, "connect").mockRejectedValue(original);
    await expect(client().connect()).rejects.toMatchObject({
      cause: original,
      diagnostic: { code: "ECONNRESET" },
    });
  });

  it("bounds the handshake and allows an explicit retry after timeout", async () => {
    const connect = vi
      .spyOn(Client.prototype, "connect")
      .mockImplementation(() => new Promise(() => undefined));
    const connection = client();
    await expect(connection.connect({ timeoutMs: 5 })).rejects.toMatchObject({
      diagnostic: { code: "TIMEOUT", phase: "connect" },
    });
    connect.mockResolvedValue();
    await expect(connection.connect()).resolves.toBeUndefined();
    await connection.disconnect();
  });

  it("propagates caller cancellation, including a custom abort reason", async () => {
    vi.spyOn(Client.prototype, "connect").mockImplementation(
      () => new Promise(() => undefined),
    );
    const connection = client();
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    const pending = connection.connect({ signal: controller.signal });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    await expect(
      connection.connect({ signal: controller.signal }),
    ).rejects.toBe(reason);
  });

  it("does not classify invalid endpoints or missing configuration as unavailable", async () => {
    const connect = vi.spyOn(Client.prototype, "connect").mockResolvedValue();
    await expect(
      new MCPClient({
        name: "invalid",
        url: "https://user:secret@example.invalid",
      }).connect(),
    ).rejects.toThrow("without URL credentials");
    await expect(
      new MCPClient({
        name: "invalid",
        command: "$MISSING",
        inherit_env: false,
      }).connect(),
    ).rejects.toThrow("unset environment");
    expect(connect).not.toHaveBeenCalled();
  });
});
