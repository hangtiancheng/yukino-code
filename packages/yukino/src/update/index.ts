import { version } from "@/bootstrap/version.js";
import { getSelfUpdateCommand, runSelfUpdate } from "@/update/install.js";
import { getLatestVersion, isNewerVersion } from "@/update/version-check.js";
import { asErrorString } from "@/utils/format.js";

export * from "@/update/constants.js";
export * from "@/update/install.js";
export * from "@/update/version-check.js";

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
    console.error(`Update failed: ${asErrorString(error)}`);
    process.exitCode = 1;
  }
}
