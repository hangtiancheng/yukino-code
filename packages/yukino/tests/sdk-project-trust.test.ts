import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppConfigSchema } from "@/config/index.js";
import type { LLMClient } from "@/llm/client.js";
import { MCPClient } from "@/mcp/client.js";
import { MCPManager } from "@/mcp/manager.js";
import {
  resolveProjectConfig,
  type ProjectContext,
  type ProjectTrustRequest,
  type TrustDecision,
} from "@/project/index.js";
import {
  createRuntimeEnvironment,
  type RuntimeEnvironment,
} from "@/remote/runtime-environment.js";
import * as runtimeFactory from "@/runtime/factory.js";
import type { AgentRuntime } from "@/runtime/types.js";
import type { AgentSession } from "@/sdk/agent-session.js";
import { createAgentSession } from "@/sdk/factory.js";
import { SessionManager } from "@/session/manager.js";
import { yukinoPath } from "@/storage/index.js";

const sessions: AgentSession[] = [];
const environments: RuntimeEnvironment[] = [];
const projects: ProjectContext[] = [];
const runtimes: AgentRuntime[] = [];
const borrowedManagers: MCPManager[] = [];
let cwd: string;
let connections: string[];
const realCreateRuntime = runtimeFactory.createAgentRuntime;

async function captureRuntime(
  options: Parameters<typeof realCreateRuntime>[0],
) {
  const runtime = await realCreateRuntime(options);
  runtimes.push(runtime);
  return runtime;
}

const config = AppConfigSchema.parse({
  providers: [
    {
      name: "local",
      protocol: "openai-compat",
      base_url: "http://127.0.0.1:1/v1",
      model: "original",
    },
  ],
  enable_memory: false,
});
const client: LLMClient = {
  protocol: "openai-compat",
  setSystemPrompt: () => undefined,
  async *stream() {
    await Promise.resolve();
    yield { type: "text_delta", text: "usable" };
    yield {
      type: "stream_end",
      stopReason: "end_turn",
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    };
  },
};

function manifest(directory = cwd, version = "initial", cleanupFails = false) {
  mkdirSync(join(directory, ".yukino", "extensions"), { recursive: true });
  mkdirSync(join(directory, ".yukino", "prompts"), { recursive: true });
  writeFileSync(
    join(directory, ".yukino", "prompts", "repo.md"),
    "Repo-only prompt",
  );
  writeFileSync(
    join(directory, ".yukino", "config.yaml"),
    JSON.stringify({
      theme: "light",
      extensions: [{ name: "fixture", path: "extensions/fixture.mjs" }],
    }),
  );
  writeFileSync(
    join(directory, ".mcp.json"),
    JSON.stringify({
      mcpServers: { repo: { command: `mock-${version}` } },
    }),
  );
  writeFileSync(
    join(directory, ".yukino", "extensions", "fixture.mjs"),
    `
import { appendFileSync } from "node:fs";
export async function activate(context) {
  appendFileSync(${JSON.stringify(join(directory, "activations"))}, ${JSON.stringify(`${version}\n`)});
  await context.registerMcpServer({ name: "extension", command: "mock-extension" });
  return async () => {
    appendFileSync(${JSON.stringify(join(directory, "cleanups"))}, "cleanup\\n");
    ${cleanupFails ? 'throw new Error("extension cleanup failure");' : 'await context.unregisterMcpServer("extension");'}
  };
}
`,
  );
}
function activations(directory = cwd): string[] {
  const path = join(directory, "activations");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n") : [];
}
function grant(project: ProjectContext) {
  return { identity: project.identity, fingerprint: project.fingerprint };
}
async function make(
  trust: TrustDecision = "once",
  borrowed = false,
  onTrustRequest?: (request: ProjectTrustRequest) => Promise<TrustDecision>,
) {
  let mcpManager: MCPManager | undefined;
  if (borrowed) {
    mcpManager = new MCPManager({
      authorizeProject: () => true,
      clientFactory: (server, apps, options) =>
        new MCPClient(server, apps, options),
    });
    borrowedManagers.push(mcpManager);
    await mcpManager.connectAll([
      { name: "unrelated", command: "mock-unrelated" },
    ]);
  }
  const result = await createAgentSession({
    cwd,
    config,
    client,
    trust,
    persist: false,
    mcpManager,
    onTrustRequest,
    onPermissionRequest: () => Promise.resolve("allow"),
  });
  sessions.push(result.session);
  return { ...result, mcpManager };
}
async function shared(
  directory = cwd,
  authorizedProject?: ReturnType<typeof grant>,
  onTrustRequest?: (request: ProjectTrustRequest) => Promise<TrustDecision>,
) {
  const environment = await createRuntimeEnvironment(
    config,
    SessionManager.create(directory, { persist: false }),
    {
      client,
      enableCoordinatorMode: false,
      invocationOptions: { cwd, trustProject: true },
      authorizedProject,
      onTrustRequest,
    },
  );
  environments.push(environment);
  return environment;
}

beforeEach(() => {
  vi.stubEnv("HOME", homedir());
  cwd = join(homedir(), "project");
  mkdirSync(cwd);
  cwd = realpathSync(cwd);
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  connections = [];
  vi.spyOn(MCPClient.prototype, "connect").mockImplementation(async function (
    this: MCPClient,
  ) {
    connections.push(this.name);
    await Promise.resolve();
  });
  vi.spyOn(MCPClient.prototype, "listTools").mockResolvedValue([]);
  vi.spyOn(MCPClient.prototype, "disconnect").mockResolvedValue(undefined);
  vi.spyOn(MCPClient.prototype, "readResource").mockResolvedValue({
    contents: [{ uri: "docs://repo", text: "repo-resource" }],
  });
  vi.spyOn(runtimeFactory, "createAgentRuntime").mockImplementation(
    captureRuntime,
  );
  manifest();
});
afterEach(async () => {
  await Promise.allSettled(
    sessions.splice(0).map((session) => session.dispose()),
  );
  await Promise.allSettled([
    ...environments
      .splice(0)
      .flatMap((environment) => [
        environment.project.dispose(),
        environment.runtime.dispose(),
      ]),
    ...projects.splice(0).map((project) => project.dispose()),
    ...runtimes.splice(0).map((runtime) => runtime.dispose()),
    ...borrowedManagers.splice(0).map((manager) => manager.disconnectAll()),
  ]);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("SDK project authorization across rebuilds", () => {
  const revocationCases = (["once", "persistent"] as const).flatMap((trust) =>
    [false, true].flatMap((borrowed) =>
      ["dispose", "denied setup"].map((failure) => ({
        trust,
        borrowed,
        failure,
      })),
    ),
  );
  it.each(revocationCases)(
    "never rolls back $trust revocation after $failure failure (borrowed=$borrowed)",
    async ({ trust, borrowed, failure }) => {
      const approval = vi.fn(() =>
        Promise.resolve<TrustDecision>("persistent"),
      );
      const { session, mcpManager } = await make(trust, borrowed, approval);
      const first = runtimes[0];
      const originalProject = await resolveProjectConfig(cwd, config, {
        trust: "once",
      });
      projects.push(originalProject.project);
      const record = yukinoPath(
        "project-trust",
        `${originalProject.project.identity}.json`,
      );
      expect(existsSync(record)).toBe(trust === "persistent");
      expect(
        (await session.readMCPResource("repo", "docs://repo")).output,
      ).toContain("repo-resource");
      const initialConnections = [...connections];
      const primary = new Error(`primary ${failure}`);
      const dispose = vi.spyOn(first, "dispose");
      if (failure === "dispose") {
        dispose.mockRejectedValueOnce(primary);
      } else {
        vi.mocked(runtimeFactory.createAgentRuntime).mockImplementationOnce(
          async (options) => {
            const runtime = await captureRuntime(options);
            runtime.refreshMcpTools = () => Promise.reject(primary);
            return runtime;
          },
        );
      }
      await expect(session.revokeProjectTrust()).rejects.toBe(primary);
      expect(originalProject.project.trusted).toBe(false);
      expect(originalProject.project.getResourcePaths("prompts")).toEqual([]);
      expect(
        (await originalProject.project.loadCommands()).map(
          (command) => command.name,
        ),
      ).not.toContain("repo");
      expect(activations()).toEqual(["initial"]);
      expect(connections).toEqual(initialConnections);
      expect(approval).not.toHaveBeenCalled();
      expect(existsSync(record)).toBe(false);
      await Promise.all(
        runtimes
          .slice(0, -1)
          .map((runtime) =>
            expect(runtime.clearConversation()).rejects.toThrow(/disposed/i),
          ),
      );
      expect(
        session
          .getProjectSources()
          .some((source) => source.scope === "project"),
      ).toBe(false);
      expect(
        session
          .getMCPState()
          .servers.some((server) => server.source.scope === "project"),
      ).toBe(false);
      await expect(
        session.readMCPResource("repo", "docs://repo"),
      ).rejects.toThrow();
      expect(
        vi.spyOn(MCPClient.prototype, "readResource"),
      ).toHaveBeenCalledTimes(1);
      expect(first.mcpManager?.connectedServers()).toEqual(
        borrowed ? ["unrelated"] : [],
      );
      expect(dispose).toHaveBeenCalled();
      if (failure === "dispose") {
        expect(dispose.mock.calls.length).toBeGreaterThanOrEqual(2);
      }
      expect(
        (await session.prompt("still usable without project resources")).status,
      ).toBe("completed");
      await session.setModel("after-revoke", client);
      expect(activations()).toEqual(["initial"]);
      expect(existsSync(record)).toBe(false);
      if (mcpManager) {
        expect(mcpManager.connectedServers()).toEqual(["unrelated"]);
      }
    },
  );

  it("commits denial before a rejecting project revoke and still closes the old runtime", async () => {
    manifest(cwd, "initial", true);
    const { session } = await make("persistent");
    const first = runtimes[0];
    const close = vi.spyOn(first, "dispose");
    await expect(session.revokeProjectTrust()).rejects.toThrow(
      "Project resource cleanup failed",
    );
    expect(close).toHaveBeenCalled();
    expect(first.mcpManager?.connectedServers()).toEqual([]);
    expect(activations()).toEqual(["initial"]);
    expect(
      session.getProjectSources().some((source) => source.scope === "project"),
    ).toBe(false);
    expect((await session.prompt("denied rollback is usable")).status).toBe(
      "completed",
    );
    expect(readFileSync(join(cwd, "cleanups"), "utf8")).toBe("cleanup\n");
    expect(readdirSync(yukinoPath("project-trust"))).toEqual([]);
  });

  it.each([false, true])(
    "preserves the primary revocation error when denied rollback setup also fails (borrowed=%s)",
    async (borrowed) => {
      const { session, mcpManager } = await make("persistent", borrowed);
      const primary = new Error("primary disposal failure");
      vi.spyOn(runtimes[0], "dispose").mockRejectedValueOnce(primary);
      vi.mocked(runtimeFactory.createAgentRuntime).mockImplementationOnce(
        async (options) => {
          const runtime = await captureRuntime(options);
          runtime.refreshMcpTools = () =>
            Promise.reject(new Error("secondary rollback failure"));
          return runtime;
        },
      );
      await expect(session.revokeProjectTrust()).rejects.toBe(primary);
      expect(activations()).toEqual(["initial"]);
      expect(readdirSync(yukinoPath("project-trust"))).toEqual([]);
      await expect(
        session.readMCPResource("repo", "docs://repo"),
      ).rejects.toThrow();
      await Promise.all(
        runtimes.map((runtime) =>
          expect(runtime.clearConversation()).rejects.toThrow(/disposed/i),
        ),
      );
      await session.setModel("recovered", client);
      expect((await session.prompt("continue denied")).status).toBe(
        "completed",
      );
      expect(activations()).toEqual(["initial"]);
      expect(readdirSync(yukinoPath("project-trust"))).toEqual([]);
      if (mcpManager) {
        expect(mcpManager.connectedServers()).toEqual(["unrelated"]);
      }
    },
  );

  it.each(["command", "extension"])(
    "requires callback approval for an isolated changed %s fingerprint",
    async (kind) => {
      const approval = vi.fn((_request: ProjectTrustRequest) =>
        Promise.resolve<TrustDecision>("deny"),
      );
      const { session } = await make("once", false, approval);
      if (kind === "command") {
        writeFileSync(
          join(cwd, ".mcp.json"),
          JSON.stringify({
            mcpServers: { repo: { command: "mock-changed" } },
          }),
        );
      } else {
        const path = join(cwd, ".yukino", "extensions", "fixture.mjs");
        writeFileSync(
          path,
          readFileSync(path, "utf8").replace("mock-extension", "mock-changed"),
        );
      }
      await session.setModel("changed", client);
      expect(approval).toHaveBeenCalledWith(
        expect.objectContaining({ changed: true }),
      );
      expect(activations()).toEqual(["initial"]);
      expect(connections).toEqual(["repo", "extension"]);
      approval.mockResolvedValue("persistent");
      await session.setModel("approved", client);
      expect(approval).toHaveBeenCalledTimes(2);
      expect(activations()).toEqual(["initial", "initial"]);
      expect(connections).toEqual(["repo", "extension", "repo", "extension"]);
      const request = approval.mock.calls[1][0];
      const record = yukinoPath("project-trust", `${request.identity}.json`);
      expect(readFileSync(record, "utf8")).toContain(request.fingerprint);
      await session.setModel("unchanged", client);
      expect(approval).toHaveBeenCalledTimes(2);
    },
  );

  it("keeps canonical revocation across cwd switches without denying unrelated project approvals", async () => {
    const approval = vi.fn(() => Promise.resolve<TrustDecision>("once"));
    const { session } = await make("once", false, approval);
    await session.revokeProjectTrust();
    const other = join(homedir(), "other");
    manifest(other);
    await session.switchSession(
      SessionManager.create(other, { persist: false }),
      { destination: other },
    );
    expect(approval).toHaveBeenCalledOnce();
    expect(activations(other)).toEqual(["initial"]);
    const alias = join(homedir(), "alias");
    symlinkSync(cwd, alias);
    await session.switchSession(
      SessionManager.create(alias, { persist: false }),
      { destination: alias },
    );
    expect(approval).toHaveBeenCalledOnce();
    expect(activations()).toEqual(["initial"]);
    expect(session.getMCPState().connectedServers).toEqual([]);
  });

  it.each(["once", "persistent"] as const)(
    "binds initial %s approval, retaining unchanged rebuilds but reviewing changed MCP and extension execution",
    async (trust) => {
      const approval = vi.fn(() => Promise.resolve<TrustDecision>("deny"));
      const { session } = await make(trust, false, approval);
      expect(activations()).toEqual(["initial"]);
      expect(approval).not.toHaveBeenCalled();
      await session.setModel("unchanged", client);
      expect(activations()).toEqual(["initial", "initial"]);
      expect(approval).not.toHaveBeenCalled();
      manifest(cwd, "changed");
      await session.setModel("changed-model", client);
      expect(approval).toHaveBeenCalledOnce();
      expect(approval).toHaveBeenLastCalledWith(
        expect.objectContaining({ changed: true, cwd }),
      );
      expect(activations()).toEqual(["initial", "initial"]);
      expect(session.getMCPState().connectedServers).toEqual([]);
      await expect(
        session.readMCPResource("repo", "docs://repo"),
      ).rejects.toThrow();
      approval.mockResolvedValue("once");
      await session.setModel("approved-model", client);
      expect(approval).toHaveBeenCalledTimes(2);
      expect(activations()).toEqual(["initial", "initial", "changed"]);
      expect(session.getMCPState().connectedServers).toEqual([
        "repo",
        "extension",
      ]);
      await session.setModel("approved-unchanged", client);
      expect(approval).toHaveBeenCalledTimes(2);
    },
  );

  it("does not approve changed execution without a trust callback", async () => {
    const { session } = await make();
    manifest(cwd, "changed");
    await session.setModel("new-model", client);
    expect(activations()).toEqual(["initial"]);
    expect(session.getMCPState().connectedServers).toEqual([]);
  });

  it("retains canonical alias approval but never approves another cwd or a retargeted alias", async () => {
    const approval = vi.fn(() => Promise.resolve<TrustDecision>("deny"));
    const { session } = await make("once", false, approval);
    const alias = join(homedir(), "alias");
    symlinkSync(cwd, alias);
    await session.switchSession(
      SessionManager.create(alias, { persist: false }),
    );
    expect(approval).not.toHaveBeenCalled();
    expect(activations()).toHaveLength(2);
    const other = join(homedir(), "other");
    manifest(other);
    await expect(
      session.switchSession(SessionManager.create(other, { persist: false }), {
        destination: other,
      }),
    ).rejects.toThrow(/trust was not approved/);
    expect(session.cwd).toBe(cwd);
    expect(approval).toHaveBeenCalledOnce();
    expect(activations(other)).toEqual([]);
    await session.switchSession(
      SessionManager.create(alias, { persist: false }),
    );
    expect(approval).toHaveBeenCalledOnce();
    expect(activations()).toHaveLength(3);
    unlinkSync(alias);
    symlinkSync(other, alias);
    await expect(
      session.switchSession(SessionManager.create(alias, { persist: false }), {
        destination: alias,
      }),
    ).rejects.toThrow(/trust was not approved/);
    expect(session.cwd).toBe(cwd);
    expect(approval).toHaveBeenCalledTimes(2);
    expect(activations(other)).toEqual([]);
  });

  it("keeps ordinary failed model and navigation rollback usable without recreating persistence", async () => {
    const { session, sessionManager } = await make("persistent");
    const approved = await resolveProjectConfig(cwd, config);
    projects.push(approved.project);
    const record = yukinoPath(
      "project-trust",
      `${approved.project.identity}.json`,
    );
    const user = sessionManager.append({
      role: "user",
      content: "original leaf",
    });
    for (const transition of [
      () => session.setModel("failed", client),
      () => session.navigate(null),
    ]) {
      vi.mocked(runtimeFactory.createAgentRuntime).mockImplementationOnce(
        async (options) => {
          const runtime = await captureRuntime(options);
          runtime.refreshMcpTools = () =>
            Promise.reject(new Error("setup failed"));
          return runtime;
        },
      );
      const write = vi.spyOn(
        await import("@/project/trust.js"),
        "writeProjectTrust",
      );
      await expect(transition()).rejects.toThrow("setup failed");
      expect(write).not.toHaveBeenCalled();
      expect(sessionManager.leafId).toBe(user);
      expect(session.getModel().model).toBe("original");
      expect(existsSync(record)).toBe(true);
      expect(session.getMCPState().connectedServers).toEqual([
        "repo",
        "extension",
      ]);
    }
    expect((await session.prompt("rollback continued")).text).toBe("usable");
  });
});

describe("shared project approval for runtime hosts", () => {
  it("accepts a bound previous approval instead of replaying the invocation flag", async () => {
    const approval = vi.fn(() => Promise.resolve<TrustDecision>("deny"));
    const first = await shared(cwd, undefined, approval);
    expect(first.project.trusted).toBe(true);
    const authorizedProject = grant(first.project);
    await first.project.dispose();
    await first.runtime.dispose();
    const unchanged = await shared(cwd, authorizedProject, approval);
    expect(unchanged.project.trusted).toBe(true);
    expect(approval).not.toHaveBeenCalled();
    await unchanged.project.dispose();
    await unchanged.runtime.dispose();
    manifest(cwd, "changed");
    const denied = await shared(cwd, authorizedProject, approval);
    expect(denied.project.trusted).toBe(false);
    expect(approval).toHaveBeenCalledWith(
      expect.objectContaining({ changed: true }),
    );
    expect(activations()).toEqual(["initial", "initial"]);
    approval.mockResolvedValue("once");
    const approved = await shared(cwd, authorizedProject, approval);
    expect(approved.project.trusted).toBe(true);
    expect(activations()).toEqual(["initial", "initial", "changed"]);
  });

  it("never uses a previous approval for a different canonical identity", async () => {
    const first = await shared();
    const other = join(homedir(), "other");
    manifest(other);
    const approval = vi.fn(() => Promise.resolve<TrustDecision>("deny"));
    const denied = await shared(other, grant(first.project), approval);
    expect(denied.project.identity).not.toBe(first.project.identity);
    expect(denied.project.trusted).toBe(false);
    expect(approval).toHaveBeenCalledOnce();
    expect(activations(other)).toEqual([]);
  });

  it("keeps explicit denial stronger than a previous or persisted approval", async () => {
    const first = await resolveProjectConfig(cwd, config, {
      trust: "persistent",
    });
    projects.push(first.project);
    const approval = vi.fn(() => Promise.resolve<TrustDecision>("once"));
    for (const options of [{ trust: "deny" as const }, { disabled: true }]) {
      const denied = await resolveProjectConfig(cwd, config, {
        authorizedProject: grant(first.project),
        onTrustRequest: approval,
        ...options,
      });
      projects.push(denied.project);
      expect(denied.project.trusted).toBe(false);
      expect(denied.project.getResourcePaths("prompts")).toEqual([]);
    }
    expect(approval).not.toHaveBeenCalled();
  });

  it("project reload reviews changes even when the initial grant was explicit", async () => {
    const approval = vi.fn(() => Promise.resolve<TrustDecision>("deny"));
    const first = await resolveProjectConfig(cwd, config, {
      trust: "once",
      onTrustRequest: approval,
    });
    projects.push(first.project);
    const unchanged = await first.project.reload();
    projects.push(unchanged.project);
    expect(unchanged.project.trusted).toBe(true);
    manifest(cwd, "changed");
    const denied = await unchanged.project.reload();
    projects.push(denied.project);
    expect(denied.project.trusted).toBe(false);
    expect(approval).toHaveBeenCalledWith(
      expect.objectContaining({ changed: true }),
    );
  });
});
