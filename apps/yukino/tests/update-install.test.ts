import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getSelfUpdateCommand,
  packageManagerInvocation,
  runSelfUpdate,
} from "@/update/install.js";
import { PACKAGE_NAME } from "@/update/version-check.js";

const mocks = vi.hoisted(() => ({
  execFile:
    vi.fn<
      (
        command: string,
        args: string[],
        options: object,
        callback: (error: Error | null, stdout: string) => void,
      ) => void
    >(),
  spawn:
    vi.fn<(command: string, args: string[], options: object) => EventEmitter>(),
}));
vi.mock("node:child_process", () => mocks);

let directory = "";
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "yukino-update-"));
  mocks.execFile.mockReset();
  mocks.spawn.mockReset();
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function rootOutput(root: string) {
  mkdirSync(root, { recursive: true });
  mocks.execFile.mockImplementation((_command, _args, _options, callback) => {
    callback(null, `${root}\n`);
  });
}

describe("installation selection", () => {
  it("updates an npm installation from its own custom prefix", async () => {
    const prefix = join(directory, "custom prefix");
    const root = join(prefix, "lib", "node_modules");
    const installed = join(root, PACKAGE_NAME);
    mkdirSync(installed, { recursive: true });
    rootOutput(join(directory, "other npm", "lib", "node_modules"));
    const command = await getSelfUpdateCommand("1.2.3", installed);
    expect(command.command).toBe("npm");
    expect(command.args).toEqual([
      "install",
      "-g",
      "--prefix",
      prefix,
      `${PACKAGE_NAME}@1.2.3`,
      "--registry=https://registry.npmjs.org/",
    ]);
  });

  it("uses yarn for a yarn global install", async () => {
    const root = join(directory, "yarn", "global");
    const installed = join(root, "node_modules", PACKAGE_NAME);
    mkdirSync(installed, { recursive: true });
    rootOutput(root);
    expect(await getSelfUpdateCommand("1.2.3", installed)).toMatchObject({
      command: "yarn",
      args: [
        "global",
        "add",
        `${PACKAGE_NAME}@1.2.3`,
        "--registry=https://registry.npmjs.org/",
      ],
    });
  });

  it("uses pnpm for its global store layout", async () => {
    const root = join(directory, "pnpm", "global", "5");
    const installed = join(
      root,
      ".pnpm",
      "yukino@1.0.0",
      "node_modules",
      PACKAGE_NAME,
    );
    mkdirSync(installed, { recursive: true });
    rootOutput(join(root, "node_modules"));
    expect(await getSelfUpdateCommand("1.2.3", installed)).toMatchObject({
      command: "pnpm",
      args: [
        "install",
        "-g",
        `${PACKAGE_NAME}@1.2.3`,
        "--registry=https://registry.npmjs.org/",
      ],
    });
  });

  it("resolves a global root symlink", async () => {
    const root = join(directory, "actual", "node_modules");
    const installed = join(root, PACKAGE_NAME);
    mkdirSync(installed, { recursive: true });
    const link = join(directory, "global-root");
    symlinkSync(root, link, "junction");
    rootOutput(link);
    expect((await getSelfUpdateCommand("1.2.3", installed)).command).toBe(
      "npm",
    );
  });

  it("does not replace a source checkout or a local installation with a global install", async () => {
    const root = join(directory, "global", "node_modules");
    rootOutput(root);
    for (const installed of [
      join(directory, "source"),
      join(directory, "project", "node_modules", PACKAGE_NAME),
    ]) {
      mkdirSync(installed, { recursive: true });
      await expect(getSelfUpdateCommand("1.2.3", installed)).rejects.toThrow(
        "not managed by global",
      );
    }
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("still recognizes a custom npm prefix when querying npm fails", async () => {
    const installed = join(directory, "lib", "node_modules", PACKAGE_NAME);
    mkdirSync(installed, { recursive: true });
    mocks.execFile.mockImplementation((_command, _args, _options, callback) => {
      callback(new Error("npm root failed"), "");
    });
    expect((await getSelfUpdateCommand("1.2.3", installed)).args).toContain(
      directory,
    );
  });

  it("quotes Windows paths literally when running .cmd launchers", () => {
    const invocation = packageManagerInvocation(
      "npm",
      [
        "install",
        "-g",
        "--prefix",
        "C:\\O'Brien & $data",
        `${PACKAGE_NAME}@1.2.3`,
      ],
      "win32",
    );
    expect(invocation.command).toBe("powershell.exe");
    expect(invocation.args.at(-1)).toContain("'C:\\O''Brien & $data'");
    expect(invocation.args.at(-1)).toContain("exit $LASTEXITCODE");
  });
});

describe("update process", () => {
  it("waits for the package manager to finish", async () => {
    const child = new EventEmitter();
    mocks.spawn.mockReturnValue(child);
    const update = runSelfUpdate({
      command: "npm",
      args: ["install", "-g", `${PACKAGE_NAME}@1.2.3`],
    });
    child.emit("close", 0, null);
    await expect(update).resolves.toBeUndefined();
  });

  it.each(["exit", "signal", "spawn"])(
    "reports %s failures",
    async (failure) => {
      const child = new EventEmitter();
      mocks.spawn.mockReturnValue(child);
      const update = runSelfUpdate({ command: "pnpm", args: [] });
      if (failure === "spawn") {
        child.emit("error", new Error("ENOENT"));
      } else {
        child.emit(
          "close",
          failure === "exit" ? 1 : null,
          failure === "signal" ? "SIGTERM" : null,
        );
      }
      await expect(update).rejects.toThrow(
        failure === "spawn" ? "ENOENT" : "pnpm",
      );
    },
  );
});
