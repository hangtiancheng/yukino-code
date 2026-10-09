import { execFile, spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { PACKAGE_NAME } from "./version-check.js";

type PackageManager = "npm" | "yarn" | "pnpm";
export interface UpdateCommand {
  command: PackageManager;
  args: string[];
}

export function packageManagerInvocation(
  command: PackageManager,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform !== "win32") {
    return { command, args };
  }
  // PowerShell preserves literal arguments and can run the package managers' .cmd launchers.
  const invocation = [command, ...args]
    .map((arg) => `'${arg.replaceAll("'", "''")}'`)
    .join(" ");
  return {
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & ${invocation}; exit $LASTEXITCODE`,
    ],
  };
}

function getPackageDirectory(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (true) {
    try {
      const data: unknown = JSON.parse(
        readFileSync(join(directory, "package.json"), "utf8"),
      );
      if (
        z.object({ name: z.string() }).safeParse(data).data?.name ===
        PACKAGE_NAME
      ) {
        return directory;
      }
    } catch {
      // Keep looking above source and bundled entry points.
    }
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error("Could not locate the Yukino installation.");
    }
    directory = parent;
  }
}

function isInside(directory: string, root: string): boolean {
  try {
    const child = relative(realpathSync(root), realpathSync(directory));
    return (
      child !== "" &&
      child !== ".." &&
      !child.startsWith(`..${sep}`) &&
      !isAbsolute(child)
    );
  } catch {
    return false;
  }
}

export async function getSelfUpdateCommand(
  latest: string,
  packageDirectory = getPackageDirectory(),
): Promise<UpdateCommand> {
  const normalized = packageDirectory.replaceAll("\\", "/").toLowerCase();
  const command: PackageManager = /\/(?:\.pnpm|pnpm)\//u.test(normalized)
    ? "pnpm"
    : /\/(?:\.yarn|yarn)\//u.test(normalized)
      ? "yarn"
      : "npm";
  const query = packageManagerInvocation(
    command,
    command === "yarn" ? ["global", "dir"] : ["root", "-g"],
  );
  let globalRoot = "";
  try {
    globalRoot = await new Promise<string>((resolve, reject) => {
      execFile(
        query.command,
        query.args,
        {
          encoding: "utf8",
          timeout: 10_000,
          windowsHide: true,
        },
        (error, stdout) => {
          if (error) {
            reject(new Error(error.message, { cause: error }));
          } else {
            resolve(stdout.trim());
          }
        },
      );
    });
  } catch {
    // A custom npm prefix can still be inferred from the installation path.
  }

  const npmRoot = dirname(dirname(packageDirectory));
  const inferredNpmPrefix =
    command === "npm" &&
    normalized.endsWith(`/lib/node_modules/${PACKAGE_NAME}`)
      ? dirname(dirname(npmRoot))
      : undefined;
  const roots = [globalRoot, ...(inferredNpmPrefix ? [npmRoot] : [])];
  if (command === "pnpm" && globalRoot) {
    roots.push(dirname(globalRoot));
  }
  if (!roots.some((root) => root && isInside(packageDirectory, root))) {
    throw new Error(
      "This Yukino installation is not managed by global npm, yarn, or pnpm. " +
        "Update the source checkout or reinstall using yukino-code/install.sh or yukino-code/install.ps1.",
    );
  }

  return {
    command,
    args: [
      ...(command === "yarn" ? ["global", "add"] : ["install", "-g"]),
      ...(inferredNpmPrefix ? ["--prefix", inferredNpmPrefix] : []),
      `${PACKAGE_NAME}@${latest}`,
      "--registry=https://registry.npmjs.org/",
    ],
  };
}

export async function runSelfUpdate(update: UpdateCommand): Promise<void> {
  const invocation = packageManagerInvocation(update.command, update.args);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            signal
              ? `${update.command} was terminated by ${signal}.`
              : `${update.command} exited with code ${code ?? "unknown"}.`,
          ),
        );
      }
    });
  });
}
