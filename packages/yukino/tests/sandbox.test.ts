import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeSandbox } from "@/sandbox/index.js";
import { TaskManager } from "@/subagent/task-manager.js";
import { BashTool } from "@/tools/bash.js";

const directories: string[] = [];
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "yukino-sandbox-"));
  directories.push(path);
  return path;
}
const quote = (path: string): string => `'${path.replaceAll("'", "'\\''")}'`;

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("sandbox-runtime adapter", () => {
  it("reports dependency errors without executing a command", async () => {
    vi.spyOn(SandboxManager, "checkDependenciesAsync").mockResolvedValue({
      errors: ["bubblewrap unavailable"],
      warnings: [],
    });
    const sandbox = new RuntimeSandbox();
    expect(await sandbox.available()).toBe(false);
    expect(sandbox.availabilityError).toBe("bubblewrap unavailable");
    const bash = new BashTool();
    bash.sandbox = sandbox;
    const cwd = directory();
    const result = await bash.execute(
      { cwd, sessionId: "native-sandbox" },
      { command: "touch never" },
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("bubblewrap unavailable");
    expect(existsSync(join(cwd, "never"))).toBe(false);
  });

  it("resolves literal paths and keeps each command's policy in its own process", () => {
    const sandbox = new RuntimeSandbox();
    const prepared = sandbox.prepare(
      "printf ok",
      {
        allowWrite: ["a[b]"],
        denyWrite: ["private"],
        networkEnabled: false,
      },
      {
        cwd: "/workspace",
        shellPath: "/opt/custom shell/bash",
        commandId: "command-1",
      },
    );
    expect(prepared.executable).toBe(process.execPath);
    expect(prepared.args[0]).toContain("sandbox-worker.js");
    const deniedPaths: unknown = expect.arrayContaining([
      { path: "/workspace/private", literal: true },
    ]);
    expect(JSON.parse(prepared.args[1])).toMatchObject({
      command: "printf ok",
      shellPath: "/opt/custom shell/bash",
      commandId: "command-1",
      config: {
        filesystem: {
          allowWrite: [{ path: "/workspace/a[b]", literal: true }],
          denyWrite: deniedPaths,
        },
        network: {
          allowedDomains: [],
          strictAllowlist: true,
          allowLocalBinding: false,
        },
      },
    });
  });
});

const dependencies = await SandboxManager.checkDependenciesAsync();
describe.skipIf(
  dependencies.errors.length > 0 ||
    !["darwin", "linux"].includes(process.platform),
)("native sandbox-runtime execution", () => {
  function tool(cwd: string): BashTool {
    const bash = new BashTool();
    bash.sandbox = new RuntimeSandbox();
    bash.sandboxConfig = {
      allowWrite: [cwd],
      denyWrite: [join(cwd, "protected")],
      networkEnabled: false,
    };
    return bash;
  }

  it("allows workspace writes and denies outside and explicit protected paths", async () => {
    const cwd = directory();
    const outside = directory();
    const bash = tool(cwd);
    expect(
      (
        await bash.execute(
          { cwd, sessionId: "native-sandbox" },
          { command: "printf ok > allowed" },
        )
      ).isError,
    ).toBe(false);
    expect(readFileSync(join(cwd, "allowed"), "utf8")).toBe("ok");
    for (const path of [join(outside, "denied"), join(cwd, "protected")]) {
      const denied = await bash.execute(
        { cwd, sessionId: "native-sandbox" },
        { command: `touch ${quote(path)}` },
      );
      expect(denied.isError, denied.output).toBe(true);
      expect(existsSync(path)).toBe(false);
    }
  }, 30_000);

  it("does not share policies between simultaneous background commands", async () => {
    const a = directory();
    const b = directory();
    const tasks = new TaskManager();
    const run = async (cwd: string, other: string) => {
      const sandbox = tool(cwd);
      sandbox.taskManager = tasks;
      return sandbox.execute(
        { cwd, sessionId: "native-sandbox" },
        {
          command: `touch own; touch ${quote(join(other, "cross"))}`,
          run_in_background: true,
        },
      );
    };
    try {
      const results = await Promise.all([run(a, b), run(b, a)]);
      expect(results.every((result) => !result.isError)).toBe(true);
      await Promise.all(tasks.list().map((task) => task.done));
      for (const cwd of [a, b]) {
        expect(existsSync(join(cwd, "own"))).toBe(true);
        expect(existsSync(join(cwd, "cross"))).toBe(false);
      }
      expect(tasks.list().every((task) => task.status === "failed")).toBe(true);
    } finally {
      await tasks.stopAll();
    }
  }, 30_000);

  it("preserves custom shell paths containing spaces and the actual exit code", async () => {
    const cwd = directory();
    const shell = join(cwd, "custom shell");
    symlinkSync("/bin/bash", shell);
    const bash = tool(cwd);
    bash.shellPath = shell;
    bash.shellCommandPrefix = "export VALUE=prefix";
    const result = await bash.execute(
      { cwd, sessionId: "native-sandbox" },
      { command: 'printf "$VALUE"; exit 7' },
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("prefix");
    expect(result.output).toContain("Exit code 7");
  }, 15_000);

  it("cancels runtime initialization and execution without running delayed effects", async () => {
    const cwd = directory();
    const controller = new AbortController();
    const pending = tool(cwd).execute(
      { cwd, sessionId: "native-sandbox", abortSignal: controller.signal },
      { command: "sleep 5; touch never" },
    );
    setTimeout(() => {
      controller.abort();
    }, 100);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(existsSync(join(cwd, "never"))).toBe(false);
  }, 15_000);

  it("blocks direct TCP access with network disabled", async () => {
    const server = createServer((socket) => socket.end());
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP listener");
    }
    const cwd = directory();
    const command = `${quote(process.execPath)} -e 'const s=require("node:net").connect(${address.port},"127.0.0.1"); s.on("connect",()=>process.exit(0)); s.on("error",()=>process.exit(8)); setTimeout(()=>process.exit(9),1000)'`;
    try {
      const control = await new BashTool().execute(
        { cwd, sessionId: "network-control" },
        { command },
      );
      expect(control.isError, control.output).toBe(false);
      const result = await tool(cwd).execute(
        { cwd, sessionId: "native-sandbox" },
        { command },
      );
      expect(result.isError, result.output).toBe(true);
      if (process.platform === "darwin") {
        const enabled = tool(cwd);
        enabled.sandboxConfig.networkEnabled = true;
        const allowed = await enabled.execute(
          { cwd, sessionId: "native-sandbox" },
          { command },
        );
        expect(allowed.isError, allowed.output).toBe(false);
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        }),
      );
    }
  }, 15_000);
});
