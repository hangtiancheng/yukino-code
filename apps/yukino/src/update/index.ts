import { parseArgs } from "node:util";

import { getSelfUpdateCommand, runSelfUpdate } from "./install.js";
import { getLatestVersion, isNewerVersion } from "./version-check.js";

import { version } from "@/version.js";

export * as Install from "./install.js";
export * as VersionCheck from "./version-check.js";

const UPDATE_USAGE = "Usage: yukino update [--tag <tag>]";

function parseUpdateOptions(args: string[]) {
  try {
    return parseArgs({
      args,
      options: {
        tag: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n${UPDATE_USAGE}`,
      { cause: error },
    );
  }
}

export async function handleUpdateCommand(args: string[]): Promise<boolean> {
  if (args.length === 1 && ["--version", "-v"].includes(args[0])) {
    console.log(version);
    return true;
  }
  if (args[0] !== "update") {
    return false;
  }
  try {
    const options = parseUpdateOptions(args.slice(1));
    if (options.help) {
      console.log(
        `${UPDATE_USAGE}\n\nUpdate Yukino from an npm dist-tag.\n\nOptions:\n  --tag <tag>  npm dist-tag to check (default: latest)\n  -h, --help   Show this help\n\nExamples:\n  yukino update\n  yukino update --tag=canary`,
      );
      return true;
    }
    const latest = await getLatestVersion({ tag: options.tag });
    if (!isNewerVersion(latest, version)) {
      console.log(`Yukino is already up to date (v${version}).`);
      return true;
    }
    const command = await getSelfUpdateCommand(latest);
    console.log(
      `Updating Yukino from v${version} to v${latest} with ${command.command}...`,
    );
    await runSelfUpdate(command);
    console.log(`Updated Yukino from v${version} to v${latest}.`);
  } catch (error) {
    console.error(
      `Update failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
  return true;
}
