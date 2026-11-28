import { afterEach, describe, expect, it, vi } from "vitest";

import {
  executeMCPCommand,
  expandMCPResourceTemplate,
  formatMCPStatus,
  parseMCPCommand,
} from "@/mcp/commands.js";
import type { MCPCommandContext } from "@/mcp/commands.js";
import type { MCPServerConfig } from "@/mcp/config.js";
import {
  MCP_COMMAND_APPLY,
  MCP_COMMAND_CANCEL,
  MCP_COMMAND_CANCELLED,
  MCP_COMMAND_EMPTY,
  MCP_COMMAND_FAILED,
  MCP_COMMAND_GLOBAL_RELOAD,
  MCP_COMMAND_INVALID,
  MCP_COMMAND_INVALID_ANSWER,
  MCP_COMMAND_INVALID_OAUTH,
  MCP_COMMAND_INVALID_TEMPLATE,
  MCP_COMMAND_INVALID_URI,
  MCP_COMMAND_NEXT,
  MCP_COMMAND_PAGE_SIZE,
  MCP_COMMAND_READ,
  MCP_COMMAND_STALE,
  MCP_COMMAND_WAIT,
  MCP_MAX_PAGES,
  MCP_OAUTH_CALLBACK_TTL_MS,
} from "@/mcp/constants.js";
import { MCPManager } from "@/mcp/manager.js";
import { MCPOAuthCallback } from "@/mcp/oauth.js";
import type { MCPResourceToolResult } from "@/mcp/resources.js";
import type { Asker, Question } from "@/tools/ask-user.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function scripted(...answers: (string | number)[]) {
  return vi.fn<Asker>((questions, signal) => {
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(questions).toHaveLength(1);
    const question = questions[0];
    expect(question.multiSelect).toBe(false);
    expect(question.options.length).toBeGreaterThanOrEqual(2);
    expect(question.options.length).toBeLessThanOrEqual(4);
    const next = answers.shift();
    if (next === undefined) {
      throw new Error("Missing scripted answer");
    }
    const answer =
      typeof next === "number" ? question.options[next].label : next;
    return Promise.resolve({ [question.question]: answer });
  });
}

const resource: MCPResourceToolResult = {
  output: "bounded fixture preview",
  isError: false,
  resourceArtifacts: [
    {
      id: "fixture-artifact",
      mimeType: "text/plain",
      bytes: 7,
      sha256: "fixture-hash",
      serverName: "server",
      uri: "memory://fixture",
    },
  ],
};

async function fixture(
  askUser: Asker = scripted(),
  configs: MCPServerConfig[] = [{ name: "server", command: "local-fixture" }],
) {
  const manager = new MCPManager();
  const source = manager.createSource("global", "fixture-owner");
  for (const config of configs) {
    await manager.registerServer(config, source);
  }
  const state = manager.states()[0];
  const management = {
    connect: vi
      .fn<MCPCommandContext["management"]["connect"]>()
      .mockResolvedValue(state),
    disconnect: vi
      .fn<MCPCommandContext["management"]["disconnect"]>()
      .mockResolvedValue(undefined),
    reload: vi
      .fn<MCPCommandContext["management"]["reload"]>()
      .mockResolvedValue(state),
    login: vi
      .fn<MCPCommandContext["management"]["login"]>()
      .mockResolvedValue(undefined),
    logout: vi
      .fn<MCPCommandContext["management"]["logout"]>()
      .mockResolvedValue(undefined),
    listResources: vi
      .fn<MCPCommandContext["management"]["listResources"]>()
      .mockResolvedValue({ items: [] }),
    readResource: vi
      .fn<MCPCommandContext["management"]["readResource"]>()
      .mockResolvedValue(resource),
    setExposure: vi
      .fn<MCPCommandContext["management"]["setExposure"]>()
      .mockResolvedValue(undefined),
  };
  const controller = new AbortController();
  const context: MCPCommandContext = {
    management,
    manager,
    askUser,
    signal: controller.signal,
  };
  return { management, manager, context, controller, source };
}

function oauthFixture() {
  const callback = new MCPOAuthCallback(
    new URL("http://127.0.0.1:4567/mcp/oauth/callback"),
    new URL("https://fixture.invalid"),
  );
  const authorization = new URL("https://fixture.invalid/authorize");
  authorization.searchParams.set("state", callback.state);
  authorization.searchParams.set("redirect_uri", callback.redirectUrl.href);
  authorization.searchParams.set("code_challenge", "fixture-challenge");
  authorization.searchParams.set("code_challenge_method", "S256");
  const callbackURL = new URL(callback.redirectUrl);
  callbackURL.searchParams.set("state", callback.state);
  callbackURL.searchParams.set("code", "fixture-code");
  return { callback, authorization, callbackURL };
}

function attachOAuth(
  management: Awaited<ReturnType<typeof fixture>>["management"],
  oauth: ReturnType<typeof oauthFixture>,
) {
  const submit = vi.fn((url: string) => {
    oauth.callback.accept(url);
  });
  management.login.mockImplementation(async (_server, options, signal) => {
    expect(options.signal).toBe(signal);
    const cancel = () => {
      oauth.callback.cancel();
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      await options.onAuthorization(oauth.authorization, submit);
      await oauth.callback.code;
      signal.throwIfAborted();
    } finally {
      signal.removeEventListener("abort", cancel);
      oauth.callback.cancel();
    }
  });
  return submit;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("MCP command parsing and read-only status", () => {
  it("preserves quotes, Unicode, shell-like characters, and argv names without a shell", () => {
    expect(
      parseMCPCommand(String.raw`connect "雪 の \"MCP\" $(touch nope);"`),
    ).toEqual({ action: "connect", server: '雪 の "MCP" $(touch nope);' });
    expect(
      parseMCPCommand(["read", "server '雪'", "memory://fixture/a%20b"]),
    ).toEqual({
      action: "read",
      server: "server '雪'",
      uri: "memory://fixture/a%20b",
    });
    expect(parseMCPCommand("exposure hidden read_tool")).toEqual({
      action: "exposure",
      exposure: "hidden",
      tool: "read_tool",
      server: undefined,
    });
    expect(parseMCPCommand("read memory://fixture")).toEqual({
      action: "read",
      server: undefined,
      uri: "memory://fixture",
    });
  });

  it.each([
    "unknown",
    "connect a b",
    "status a b",
    "login a b",
    "resources a b",
    "templates a b",
    "logout a b",
    "read",
    "read a b c",
    "exposure",
    "exposure server eager",
    "exposure server hidden tool extra",
    'connect "unterminated',
    "help extra",
    "connect ''",
  ])("rejects invalid arguments before prompting: %s", async (args) => {
    const ask = scripted();
    const { context, management } = await fixture(ask);
    await expect(executeMCPCommand(args, context)).rejects.toThrow(
      MCP_COMMAND_INVALID,
    );
    expect(ask).not.toHaveBeenCalled();
    for (const method of Object.values(management)) {
      expect(method).not.toHaveBeenCalled();
    }
  });

  it("reserves bare reload for the host-global rebuild", async () => {
    const { context, management } = await fixture();
    await expect(executeMCPCommand("reload", context)).rejects.toThrow(
      MCP_COMMAND_GLOBAL_RELOAD,
    );
    expect(management.reload).not.toHaveBeenCalled();
  });

  it("shows safe source, owner, exposure, diagnostics, and help without retrying", async () => {
    const { context, management, manager } = await fixture(scripted(), [
      {
        name: "雪 server",
        command: "fixture",
        args: ["--key", "fixture-argument-secret"],
        exposure: "codemode",
        headers: { FixtureCredentialHeader: "fixture-header-secret" },
        env: { FIXTURE_CREDENTIAL_ENV: "fixture-env-secret" },
      },
    ]);
    const state = manager.states()[0];
    vi.spyOn(manager, "states").mockReturnValue([
      {
        ...state,
        state: "error",
        diagnostic: {
          serverName: "fixture-diagnostic-secret",
          transport: "stdio",
          phase: "connect",
          code: "fixture-error-secret",
          message: "fixture-raw-error-secret",
        },
      },
    ]);
    for (const args of ["", "status", 'status "雪 server"']) {
      const result = await executeMCPCommand(args, context);
      expect(result.message).toContain(
        '"雪 server": error; source=global; owner="fixture-owner"; exposure=codemode',
      );
      expect(result.message).toContain("MCP connection failed");
      expect(result.message).toContain("CodeMode exposure is unreachable");
      expect(result.message).toContain("never connects or retries");
      expect(result.message).not.toMatch(
        /fixture-(argument|header|env|diagnostic|error|raw-error)-secret|FixtureCredentialHeader|FIXTURE_CREDENTIAL_ENV/,
      );
    }
    for (const method of Object.values(management)) {
      expect(method).not.toHaveBeenCalled();
    }
    expect(formatMCPStatus(manager)).toContain(
      "/mcp connect|disconnect|login|logout",
    );
  });

  it("hides OAuth secrets and URL query credentials from status", async () => {
    const { manager } = await fixture(scripted(), [
      {
        name: "oauth",
        url: "https://fixture.invalid/mcp?key=fixture-url-secret",
        oauth: {
          issuer: "https://fixture.invalid",
          client_id: "fixture-client-id",
          client_secret: "fixture-client-secret",
        },
      },
    ]);
    const output = formatMCPStatus(manager);
    expect(output).toContain("OAuth configured");
    expect(output).not.toMatch(
      /fixture-url-secret|fixture-client-id|fixture-client-secret/,
    );
  });

  it("handles no servers and never converts unknown named servers into an interactive retry", async () => {
    const ask = scripted();
    const { context } = await fixture(ask, []);
    expect((await executeMCPCommand("", context)).message).toContain(
      "No MCP servers",
    );
    expect((await executeMCPCommand("connect", context)).message).toBe(
      "No MCP servers registered.",
    );
    await expect(executeMCPCommand("connect missing", context)).rejects.toThrow(
      "Unknown MCP server",
    );
    expect(ask).not.toHaveBeenCalled();
  });
});

describe("managed lifecycle commands", () => {
  it.each(["connect", "disconnect", "reload", "logout"])(
    "passes the owned signal only to management.%s",
    async (action) => {
      const { context, management } = await fixture();
      const result = await executeMCPCommand(`${action} server`, context);
      expect(result.message).toContain(`${action} completed`);
      if (action === "reload") {
        expect(management.reload).toHaveBeenCalledExactlyOnceWith(
          "server",
          undefined,
          context.signal,
        );
      } else if (action === "connect") {
        expect(management.connect).toHaveBeenCalledExactlyOnceWith(
          "server",
          context.signal,
        );
      } else if (action === "disconnect") {
        expect(management.disconnect).toHaveBeenCalledExactlyOnceWith(
          "server",
          context.signal,
        );
      } else {
        expect(management.logout).toHaveBeenCalledExactlyOnceWith(
          "server",
          context.signal,
        );
      }
    },
  );

  it("fails a typed connection explicitly without login, retry, or exposing raw errors", async () => {
    const { context, management } = await fixture();
    management.connect.mockRejectedValue(
      new Error("secret bearer transport error"),
    );
    await expect(executeMCPCommand("connect server", context)).rejects.toThrow(
      MCP_COMMAND_FAILED,
    );
    expect(management.connect).toHaveBeenCalledTimes(1);
    expect(management.login).not.toHaveBeenCalled();
    await executeMCPCommand("status", context);
    expect(management.connect).toHaveBeenCalledTimes(1);
  });

  it("selects omitted Unicode servers in bounded numbered pages", async () => {
    const ask = scripted(MCP_COMMAND_NEXT, 0);
    const { context, management } = await fixture(
      ask,
      ["one", "two", "雪 名前"].map((name) => ({ name, command: "fixture" })),
    );
    await executeMCPCommand("disconnect", context);
    expect(management.disconnect).toHaveBeenCalledExactlyOnceWith(
      "雪 名前",
      context.signal,
    );
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it.each([MCP_COMMAND_CANCEL, "missing"])(
    "does not act on a cancelled or unknown selection: %s",
    async (answer) => {
      const { context, management } = await fixture(scripted(answer));
      if (answer === MCP_COMMAND_CANCEL) {
        expect(await executeMCPCommand("connect", context)).toEqual({
          message: MCP_COMMAND_CANCELLED,
        });
      } else {
        await expect(executeMCPCommand("connect", context)).rejects.toThrow(
          MCP_COMMAND_INVALID_ANSWER,
        );
      }
      expect(management.connect).not.toHaveBeenCalled();
    },
  );

  it("does not reopen a form or act on a stale server selection", async () => {
    const { context, management, manager, source } = await fixture(
      async (questions) => {
        await manager.registerServer(
          { name: "host-change", command: "fixture" },
          source,
        );
        return { [questions[0].question]: questions[0].options[0].label };
      },
    );
    await expect(executeMCPCommand("connect", context)).rejects.toThrow(
      MCP_COMMAND_STALE,
    );
    expect(management.connect).not.toHaveBeenCalled();
  });
});

describe("interactive MCP resources", () => {
  it("paginates typed pages, previews the selected URI, and returns the managed result only", async () => {
    const ask = scripted(MCP_COMMAND_NEXT, 0, MCP_COMMAND_READ);
    const { context, management } = await fixture(ask);
    management.listResources
      .mockResolvedValueOnce({
        items: [
          { name: "one", uri: "memory://one" },
          { name: "two", uri: "memory://two" },
        ],
        nextCursor: "fixture-cursor",
      })
      .mockResolvedValueOnce({
        items: [{ name: "雪", uri: "memory://fixture" }],
      });
    const result = await executeMCPCommand("resources server", context);
    expect(management.listResources.mock.calls).toEqual([
      [
        "server",
        { templates: false, cursor: undefined, limit: MCP_COMMAND_PAGE_SIZE },
        context.signal,
      ],
      [
        "server",
        {
          templates: false,
          cursor: "fixture-cursor",
          limit: MCP_COMMAND_PAGE_SIZE,
        },
        context.signal,
      ],
    ]);
    expect(ask.mock.calls[2][0][0].question).toContain(
      'URI: "memory://fixture"',
    );
    expect(management.readResource).toHaveBeenCalledExactlyOnceWith(
      "server",
      "memory://fixture",
      {},
      context.signal,
    );
    expect(result).toEqual({ message: resource.output, resource });
    expect(result).not.toHaveProperty("state");
  });

  it.each([[MCP_COMMAND_CANCEL], [0, MCP_COMMAND_CANCEL]])(
    "never reads a cancelled resource picker or preview",
    async (...answers) => {
      const { context, management } = await fixture(scripted(...answers));
      management.listResources.mockResolvedValue({
        items: [{ name: "fixture", uri: "memory://fixture" }],
      });
      expect(await executeMCPCommand("resources server", context)).toEqual({
        message: MCP_COMMAND_CANCELLED,
      });
      expect(management.readResource).not.toHaveBeenCalled();
    },
  );

  it("allows explicit read without another form and propagates permission denial safely", async () => {
    const { context, management } = await fixture();
    expect(
      await executeMCPCommand("read server memory://fixture", context),
    ).toEqual({ message: resource.output, resource });
    management.readResource.mockRejectedValue(
      new Error("MCP resource denied secret-value"),
    );
    await expect(
      executeMCPCommand("read server memory://fixture", context),
    ).rejects.toThrow(MCP_COMMAND_FAILED);
  });

  it.each([
    "ui://fixture",
    "UI://fixture",
    "relative-file",
    "https://user:pass@fixture.invalid",
  ])("rejects unsafe or dedicated Apps URIs: %s", async (uri) => {
    const { context, management } = await fixture();
    await expect(
      executeMCPCommand(["read", "server", uri], context),
    ).rejects.toThrow(MCP_COMMAND_INVALID_URI);
    expect(management.readResource).not.toHaveBeenCalled();
  });

  it("bounds cursor loops and oversized page choices", async () => {
    const { context, management } = await fixture(scripted(MCP_COMMAND_NEXT));
    management.listResources.mockResolvedValue({
      items: [],
      nextCursor: "repeat",
    });
    await expect(
      executeMCPCommand("resources server", context),
    ).rejects.toThrow(MCP_COMMAND_FAILED);
    expect(management.listResources).toHaveBeenCalledTimes(2);
    management.listResources.mockResolvedValue({
      items: ["a", "b", "c"].map((name) => ({ name, uri: `memory://${name}` })),
    });
    await expect(
      executeMCPCommand("resources server", context),
    ).rejects.toThrow(MCP_COMMAND_FAILED);
    expect(management.readResource).not.toHaveBeenCalled();
  });

  it("bounds total paging even with empty pages and fresh cursors", async () => {
    const ask = vi.fn<Asker>((questions) =>
      Promise.resolve({ [questions[0].question]: MCP_COMMAND_NEXT }),
    );
    const { context, management } = await fixture(ask);
    let cursor = 0;
    management.listResources.mockImplementation(() =>
      Promise.resolve({ items: [], nextCursor: String(++cursor) }),
    );
    await expect(
      executeMCPCommand("resources server", context),
    ).rejects.toThrow(MCP_COMMAND_FAILED);
    expect(management.listResources).toHaveBeenCalledTimes(MCP_MAX_PAGES);
  });

  it("does not read after revocation during the URI confirmation", async () => {
    const { context, management, manager, source } = await fixture(
      async (questions) => {
        const question = questions[0];
        if (!question.question.startsWith("Read MCP resource")) {
          return { [question.question]: question.options[0].label };
        }
        await manager.registerServer(
          { name: "changed", command: "fixture" },
          source,
        );
        return { [question.question]: MCP_COMMAND_READ };
      },
    );
    management.listResources.mockResolvedValue({
      items: [{ name: "fixture", uri: "memory://fixture" }],
    });
    await expect(
      executeMCPCommand("resources server", context),
    ).rejects.toThrow(MCP_COMMAND_STALE);
    expect(management.readResource).not.toHaveBeenCalled();
  });
});

describe("MCP URI template parameters and RFC6570-safe encoding", () => {
  it("asks for explicit strings and arrays, then previews the expanded URI before read", async () => {
    const ask = scripted(
      0,
      "雪 /?&",
      "second'(*)",
      '["a&b","雪 x"]',
      MCP_COMMAND_READ,
    );
    const { context, management } = await fixture(ask);
    management.listResources.mockResolvedValue({
      items: [
        {
          name: "fixture",
          uriTemplate: "memory://fixture/{first,second}{?tags*}",
        },
      ],
    });
    await executeMCPCommand("templates server", context);
    const uri =
      "memory://fixture/%E9%9B%AA%20%2F%3F%26,second%27%28%2A%29?tags=a%26b&tags=%E9%9B%AA%20x";
    expect(management.listResources).toHaveBeenCalledWith(
      "server",
      { templates: true, cursor: undefined, limit: MCP_COMMAND_PAGE_SIZE },
      context.signal,
    );
    expect(ask.mock.calls[4][0][0].question).toContain(quotedURI(uri));
    expect(management.readResource).toHaveBeenCalledExactlyOnceWith(
      "server",
      uri,
      {},
      context.signal,
    );
  });

  it.each([
    [
      "memory://fixture/{path}",
      { path: "雪/a?b&c#d%20!'()*" },
      "memory://fixture/%E9%9B%AA%2Fa%3Fb%26c%23d%2520%21%27%28%29%2A",
    ],
    [
      "memory://fixture/{+path}",
      { path: "a/b%20c?x=1&y=2" },
      "memory://fixture/a/b%20c?x=1&y=2",
    ],
    [
      "memory://fixture/{+path}",
      { path: "a%21%5B%5D/[]!'(*)" },
      "memory://fixture/a%21%5B%5D/[]!'(*)",
    ],
    [
      "memory://fixture{/path*}",
      { path: ["a/b", "雪 x"] },
      "memory://fixture/a%2Fb/%E9%9B%AA%20x",
    ],
    [
      "memory://fixture/{name:1}",
      { name: "雪だ" },
      "memory://fixture/%E9%9B%AA",
    ],
    [
      "memory://fixture{;tags*}",
      { tags: ["a/b", ""] },
      "memory://fixture;tags=a%2Fb;tags",
    ],
    [
      "memory://fixture{?q,list}",
      { q: "", list: ["a&b", "c"] },
      "memory://fixture?q=&list=a%26b,c",
    ],
  ])("expands %s safely", (template, parameters, expected) => {
    expect(expandMCPResourceTemplate(template, parameters)).toBe(expected);
  });

  it("pages templates before asking parameters and accepts literal prototype-named variables", async () => {
    const { context, management } = await fixture(
      scripted(MCP_COMMAND_NEXT, 0, "雪/a", MCP_COMMAND_READ),
    );
    management.listResources
      .mockResolvedValueOnce({ items: [], nextCursor: "template-page" })
      .mockResolvedValueOnce({
        items: [
          { name: "fixture", uriTemplate: "memory://fixture/{__proto__}" },
        ],
      });
    await executeMCPCommand("templates server", context);
    expect(management.listResources).toHaveBeenNthCalledWith(
      2,
      "server",
      {
        templates: true,
        cursor: "template-page",
        limit: MCP_COMMAND_PAGE_SIZE,
      },
      context.signal,
    );
    expect(management.readResource).toHaveBeenCalledExactlyOnceWith(
      "server",
      "memory://fixture/%E9%9B%AA%2Fa",
      {},
      context.signal,
    );
  });

  it("supports an explicit empty string and cancellation without reading", async () => {
    const { context, management } = await fixture(
      scripted(0, MCP_COMMAND_EMPTY, MCP_COMMAND_CANCEL),
    );
    management.listResources.mockResolvedValue({
      items: [{ name: "fixture", uriTemplate: "memory://fixture{?q}" }],
    });
    expect(await executeMCPCommand("templates server", context)).toEqual({
      message: MCP_COMMAND_CANCELLED,
    });
    expect(management.readResource).not.toHaveBeenCalled();
  });

  it.each(['["safe",5]', '["unterminated"', '"unterminated'])(
    "rejects invalid array/string input without echoing it: %s",
    async (answer) => {
      const { context, management } = await fixture(scripted(0, answer));
      management.listResources.mockResolvedValue({
        items: [{ name: "fixture", uriTemplate: "memory://fixture/{q}" }],
      });
      await expect(
        executeMCPCommand("templates server", context),
      ).rejects.toThrow(MCP_COMMAND_INVALID_TEMPLATE);
      expect(management.readResource).not.toHaveBeenCalled();
    },
  );

  it.each([
    "memory://fixture/{x:0}",
    "memory://fixture/{x:2*}",
    "memory://fixture/{x",
    "memory://fixture/{=x}",
    "memory://fixture/{x..y}",
  ])("rejects invalid template syntax: %s", (template) => {
    expect(() => expandMCPResourceTemplate(template, { x: "value" })).toThrow(
      MCP_COMMAND_INVALID_TEMPLATE,
    );
  });
});

function quotedURI(uri: string): string {
  return JSON.stringify(uri);
}

describe("explicit interactive OAuth", () => {
  it("displays the actual returned URL and waits for the existing loopback callback", async () => {
    const ask = scripted(MCP_COMMAND_WAIT);
    const { context, management } = await fixture(ask);
    const oauth = oauthFixture();
    const submit = attachOAuth(management, oauth);
    const started = deferred<undefined>();
    ask.mockImplementationOnce((questions) => {
      expect(questions[0].question).toContain(oauth.authorization.href);
      started.resolve(undefined);
      return Promise.resolve({ [questions[0].question]: MCP_COMMAND_WAIT });
    });
    const execution = executeMCPCommand("login server", context);
    await started.promise;
    expect(submit).not.toHaveBeenCalled();
    oauth.callback.accept(oauth.callbackURL.href);
    expect((await execution).message).toContain("login completed");
    expect(management.connect).not.toHaveBeenCalled();
  });

  it("submits a full pasted callback URL once through the validated callback", async () => {
    const oauth = oauthFixture();
    const { context, management } = await fixture(
      scripted(oauth.callbackURL.href),
    );
    const submit = attachOAuth(management, oauth);
    expect(
      (await executeMCPCommand("login server", context)).message,
    ).toContain("login completed");
    expect(submit).toHaveBeenCalledExactlyOnceWith(oauth.callbackURL.href);
  });

  it.each(["wrong-state", "wrong-redirect", "authorization-code-only"])(
    "does not apply a %s callback",
    async (failure) => {
      const oauth = oauthFixture();
      const value = new URL(oauth.callbackURL);
      if (failure === "wrong-state") {
        value.searchParams.set("state", "different-session");
      } else {
        value.pathname = "/wrong-session";
      }
      const { context, management } = await fixture(
        scripted(
          failure === "authorization-code-only" ? "fixture-code" : value.href,
        ),
      );
      attachOAuth(management, oauth);
      await expect(executeMCPCommand("login server", context)).rejects.toThrow(
        MCP_COMMAND_INVALID_OAUTH,
      );
      await expect(oauth.callback.code).rejects.toThrow("cancelled or expired");
    },
  );

  it("cancels explicit OAuth without writing credentials", async () => {
    const { context, management } = await fixture(scripted(MCP_COMMAND_CANCEL));
    const oauth = oauthFixture();
    const submit = attachOAuth(management, oauth);
    expect(await executeMCPCommand("login server", context)).toEqual({
      message: MCP_COMMAND_CANCELLED,
    });
    expect(submit).not.toHaveBeenCalled();
    await expect(oauth.callback.code).rejects.toThrow("cancelled or expired");
  });

  it("treats a closed AskUser dock as cancellation even if management normalizes its error", async () => {
    const { context, management } = await fixture(() => Promise.resolve({}));
    management.login.mockImplementation(async (_server, options, signal) => {
      try {
        await options.onAuthorization(
          new URL("https://fixture.invalid/authorize"),
          vi.fn(),
        );
      } catch {
        signal.throwIfAborted();
        throw new Error("normalized provider failure");
      }
    });
    expect(await executeMCPCommand("login server", context)).toEqual({
      message: MCP_COMMAND_CANCELLED,
    });
  });

  it("rejects unsafe authorization URLs before displaying them", async () => {
    const ask = scripted();
    const { context, management } = await fixture(ask);
    management.login.mockImplementation(async (_server, options) => {
      await options.onAuthorization(
        new URL(
          "https://fixture.invalid/authorize?client_secret=fixture-secret",
        ),
        vi.fn(),
      );
    });
    await expect(executeMCPCommand("login server", context)).rejects.toThrow(
      MCP_COMMAND_INVALID_OAUTH,
    );
    expect(ask).not.toHaveBeenCalled();
  });

  it("expires a pending form and ignores a late pasted callback", async () => {
    vi.useFakeTimers();
    const response = deferred<Record<string, string>>();
    const started = deferred<Question>();
    const { context, management } = await fixture((questions) => {
      started.resolve(questions[0]);
      return response.promise;
    });
    const oauth = oauthFixture();
    const submit = attachOAuth(management, oauth);
    const execution = executeMCPCommand("login server", context);
    const rejected = expect(execution).rejects.toThrow(
      MCP_COMMAND_INVALID_OAUTH,
    );
    const question = await started.promise;
    await vi.advanceTimersByTimeAsync(MCP_OAUTH_CALLBACK_TTL_MS + 1);
    await rejected;
    response.resolve({ [question.question]: oauth.callbackURL.href });
    await response.promise;
    expect(submit).not.toHaveBeenCalled();
  });

  it("aborts OAuth waiting on generation revocation instead of applying a late response", async () => {
    const started = deferred<undefined>();
    const { context, management, manager, source } = await fixture(
      (questions) => {
        started.resolve(undefined);
        return Promise.resolve({ [questions[0].question]: MCP_COMMAND_WAIT });
      },
    );
    const oauth = oauthFixture();
    attachOAuth(management, oauth);
    const execution = executeMCPCommand("login server", context);
    const rejected = expect(execution).rejects.toThrow(MCP_COMMAND_STALE);
    await started.promise;
    await manager.registerServer(
      { name: "host-revocation", command: "fixture" },
      source,
    );
    await rejected;
    expect(() => {
      oauth.callback.accept(oauth.callbackURL.href);
    }).toThrow("expired or already consumed");
  });

  it("external cancellation ignores a late form response", async () => {
    const response = deferred<Record<string, string>>();
    const started = deferred<Question>();
    const { context, management, controller } = await fixture((questions) => {
      started.resolve(questions[0]);
      return response.promise;
    });
    const oauth = oauthFixture();
    const submit = attachOAuth(management, oauth);
    const execution = executeMCPCommand("login server", context);
    const question = await started.promise;
    controller.abort();
    expect(await execution).toEqual({ message: MCP_COMMAND_CANCELLED });
    response.resolve({ [question.question]: oauth.callbackURL.href });
    await response.promise;
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("confirmed MCP exposure changes", () => {
  const config: MCPServerConfig = {
    name: "server",
    command: "fixture",
    exposure: "deferred",
    env: { FIXTURE_KEY: "fixture-secret" },
    tool_exposure: [
      { tool: "*", exposure: "hidden" },
      { tool: "read", exposure: "direct" },
      { tool: "other", exposure: "codemode" },
    ],
  };

  it("replaces an exact rule while preserving wildcard order, other rules, and the server default", async () => {
    const ask = scripted(MCP_COMMAND_APPLY);
    const { context, management } = await fixture(ask, [config]);
    await executeMCPCommand("exposure server hidden read", context);
    expect(management.setExposure).toHaveBeenCalledExactlyOnceWith(
      "server",
      "deferred",
      [
        { tool: "*", exposure: "hidden" },
        { tool: "read", exposure: "hidden" },
        { tool: "other", exposure: "codemode" },
      ],
      context.signal,
    );
    const preview = ask.mock.calls[0][0][0].question;
    expect(preview).toContain('Tool rule: "read"');
    expect(preview).toContain("New policy: hidden");
    expect(preview).not.toMatch(/fixture-secret|FIXTURE_KEY/);
  });

  it("appends a new exact rule and preserves existing overrides on a server-default change", async () => {
    const { context, management } = await fixture(
      scripted(MCP_COMMAND_APPLY, MCP_COMMAND_APPLY),
      [config],
    );
    await executeMCPCommand("exposure server direct new_tool", context);
    expect(management.setExposure).toHaveBeenNthCalledWith(
      1,
      "server",
      "deferred",
      [
        ...(config.tool_exposure ?? []),
        { tool: "new_tool", exposure: "direct" },
      ],
      context.signal,
    );
    await executeMCPCommand("exposure server hidden", context);
    expect(management.setExposure).toHaveBeenNthCalledWith(
      2,
      "server",
      "hidden",
      config.tool_exposure,
      context.signal,
    );
  });

  it("does not apply cancelled or permission-denied exposure changes", async () => {
    const { context, management } = await fixture(
      scripted(MCP_COMMAND_CANCEL, MCP_COMMAND_APPLY),
      [config],
    );
    expect(await executeMCPCommand("exposure server direct", context)).toEqual({
      message: MCP_COMMAND_CANCELLED,
    });
    expect(management.setExposure).not.toHaveBeenCalled();
    management.setExposure.mockRejectedValue(new Error("approval denied"));
    await expect(
      executeMCPCommand("exposure server direct", context),
    ).rejects.toThrow(MCP_COMMAND_FAILED);
    expect(management.setExposure).toHaveBeenCalledTimes(1);
  });

  it("rejects a stale exposure form without rerunning or overwriting newer rules", async () => {
    const response = deferred<Record<string, string>>();
    const started = deferred<Question>();
    const ask = vi.fn<Asker>((questions) => {
      started.resolve(questions[0]);
      return response.promise;
    });
    const { context, management, manager } = await fixture(ask, [config]);
    const execution = executeMCPCommand("exposure server hidden read", context);
    const rejected = expect(execution).rejects.toThrow(MCP_COMMAND_STALE);
    const question = await started.promise;
    await manager.setExposure("server", "direct", [
      { tool: "read", exposure: "codemode" },
    ]);
    response.resolve({ [question.question]: MCP_COMMAND_APPLY });
    await rejected;
    expect(ask).toHaveBeenCalledTimes(1);
    expect(management.setExposure).not.toHaveBeenCalled();
    expect(manager.getServerConfig("server").tool_exposure).toEqual([
      { tool: "read", exposure: "codemode" },
    ]);
  });
});
