import { getSelfUpdateCommand, runSelfUpdate } from "./install.js";
import { getLatestVersion, isNewerVersion } from "./version-check.js";
import { version } from "@yukino.js/version";

export * from "./constants.js";
export * from "./install.js";
export * from "./version-check.js";

/**
 * Checks the npm dist-tag and self-installs a newer release. Argument parsing
 * belongs to the CLI entry (src/cli.ts); tag validity is owned by
 * version-check.
 */
export async function runUpdate(tag?: string): Promise<void> {
  try {
    const latest = await getLatestVersion({ tag });
    if (!isNewerVersion(latest, version)) {
      console.log(`Yukino is already up to date (v${version}).`);
      return;
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
}
