import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { BwrapSandbox } from "@/sandbox/bwrap.js";
import {
  SandboxRuntimeSandbox,
  createSandboxRuntimeConfig,
} from "@/sandbox/sandbox-runtime.js";
import { SeatbeltSandbox } from "@/sandbox/seatbelt.js";

const runtimeMock = vi.hoisted(() => {
  const state = { enabled: false };
  return {
    state,
    initialize: vi.fn(() => {
      state.enabled = true;
      return Promise.resolve();
    }),
    checkDependenciesAsync: vi.fn(
      (): Promise<{ errors: string[]; warnings: string[] }> =>
        Promise.resolve({ errors: [], warnings: [] }),
    ),
    wrapWithSandboxArgv: vi.fn(() =>
      Promise.resolve({
        argv: ["/bin/bash", "-c", "wrapped"],
        env: { TEST_SANDBOX: "1" },
      }),
    ),
    cleanupAfterCommand: vi.fn(),
    reset: vi.fn(() => {
      state.enabled = false;
      return Promise.resolve();
    }),
    annotateStderrWithSandboxFailures: vi.fn(
      (commandId: string, stderr: string) => `${stderr}[${commandId}]`,
    ),
  };
});

vi.mock("@anthropic-ai/sandbox-runtime", () => ({
  SandboxRuntimeConfigSchema: { parse: (value: unknown) => value },
  SandboxManager: {
    initialize: runtimeMock.initialize,
    isSupportedPlatform: () => true,
    isSandboxingEnabled: () => runtimeMock.state.enabled,
    checkDependenciesAsync: runtimeMock.checkDependenciesAsync,
    wrapWithSandboxArgv: runtimeMock.wrapWithSandboxArgv,
    cleanupAfterCommand: runtimeMock.cleanupAfterCommand,
    reset: runtimeMock.reset,
    annotateStderrWithSandboxFailures:
      runtimeMock.annotateStderrWithSandboxFailures,
  },
}));

const config = {
  allowWrite: ["."],
  denyWrite: ["private"],
  networkEnabled: false,
};

describe("native sandboxes", () => {
  it("prepares bwrap argv without passing the command through an outer shell", () => {
    const prepared = new BwrapSandbox().prepare(
      "true; echo still-contained",
      config,
    );

    expect(prepared.executable).toBe("bwrap");
    expect(prepared.args.slice(-4)).toEqual([
      "--",
      "bash",
      "-c",
      "true; echo still-contained",
    ]);
  });

  it("prepares seatbelt as an executable and argument vector", () => {
    const prepared = new SeatbeltSandbox().prepare("printf ok", config);

    expect(prepared.executable).toBe("/usr/bin/sandbox-exec");
    expect(prepared.args.slice(-3)).toEqual(["bash", "-c", "printf ok"]);
  });
});

describe("SandboxRuntimeSandbox", () => {
  beforeEach(() => {
    runtimeMock.state.enabled = false;
    vi.clearAllMocks();
  });

  it("maps paths and disabled networking into runtime policy", () => {
    expect(createSandboxRuntimeConfig(config, "/workspace")).toEqual({
      network: {
        allowedDomains: [],
        deniedDomains: ["*"],
        strictAllowlist: true,
      },
      filesystem: {
        denyRead: [],
        allowWrite: ["/workspace"],
        denyWrite: [resolve("/workspace", "private")],
        allowGitConfig: false,
      },
    });
  });

  it("initializes once and returns cleanup and annotation hooks", async () => {
    const sandbox = new SandboxRuntimeSandbox();
    expect(await sandbox.available()).toBe(true);

    const prepared = await sandbox.prepare("printf ok", config, {
      cwd: "/workspace",
      commandId: "tool-1",
    });
    await sandbox.prepare("printf again", config, {
      cwd: "/workspace",
      commandId: "tool-2",
    });

    expect(runtimeMock.initialize).toHaveBeenCalledTimes(1);
    expect(prepared).toMatchObject({
      executable: "/bin/bash",
      args: ["-c", "wrapped"],
      env: { TEST_SANDBOX: "1" },
    });
    expect(prepared.annotateStderr?.("denied")).toBe("denied[tool-1]");
    await prepared.cleanup?.();
    expect(runtimeMock.cleanupAfterCommand).toHaveBeenCalledOnce();

    await sandbox.dispose();
    expect(runtimeMock.reset).toHaveBeenCalledOnce();
  });

  it("reports dependency failures without initializing", async () => {
    runtimeMock.checkDependenciesAsync.mockResolvedValueOnce({
      errors: ["missing bwrap"],
      warnings: [],
    });
    const sandbox = new SandboxRuntimeSandbox();

    expect(await sandbox.available()).toBe(false);
    expect(sandbox.availabilityError).toBe("missing bwrap");
    expect(runtimeMock.initialize).not.toHaveBeenCalled();
  });
});
