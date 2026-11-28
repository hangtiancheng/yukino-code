import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PACKAGE_NAME } from "@/update/constants.js";
import {
  getSelfUpdateCommand,
  packageManagerInvocation,
  runSelfUpdate,
} from "@/update/install.js";

const mocks = vi.hoisted(() => ({
  execa:
    vi.fn<
      (
        command: string,
        args: readonly string[],
        options?: object,
      ) => Promise<{ stdout: string }>
    >(),
}));
vi.mock("execa", () => mocks);

let directory = "";
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "yukino-update-"));
  mocks.execa.mockReset();
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function rootOutput(root: string) {
  mkdirSync(root, { recursive: true });
  mocks.execa.mockResolvedValue({ stdout: `${root}\n` });
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
    expect(
      mocks.execa.mock.calls.every((call) => !call[1].includes("install")),
    ).toBe(true);
  });

  it("still recognizes a custom npm prefix when querying npm fails", async () => {
    const installed = join(directory, "lib", "node_modules", PACKAGE_NAME);
    mkdirSync(installed, { recursive: true });
    mocks.execa.mockRejectedValue(new Error("npm root failed"));
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
    const completion = Promise.withResolvers<{ stdout: string }>();
    mocks.execa.mockReturnValue(completion.promise);
    let finished = false;
    const update = runSelfUpdate({
      command: "npm",
      args: ["install", "-g", `${PACKAGE_NAME}@1.2.3`],
    }).then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    completion.resolve({ stdout: "" });
    await update;
    expect(finished).toBe(true);
    expect(mocks.execa).toHaveBeenCalledWith(
      "npm",
      ["install", "-g", `${PACKAGE_NAME}@1.2.3`],
      { stdio: "inherit" },
    );
  });
  it.each(["pnpm exited with code 1", "pnpm terminated by SIGTERM", "ENOENT"])(
    "reports %s",
    async (message) => {
      mocks.execa.mockRejectedValue(new Error(message));
      await expect(
        runSelfUpdate({ command: "pnpm", args: [] }),
      ).rejects.toThrow(message);
    },
  );
});
