import semver from "semver";
import { z } from "zod";

import { version } from "@/bootstrap/version.js";
import {
  DEFAULT_DIST_TAG,
  PACKAGE_URL,
  REGISTRY_FETCH_TIMEOUT_MS,
} from "@/update/constants.js";

export function isNewerVersion(candidate: string, current: string): boolean {
  return semver.gt(candidate, current);
}

export async function getLatestVersion({
  tag = DEFAULT_DIST_TAG,
  signal,
}: {
  tag?: string;
  signal?: AbortSignal;
} = {}): Promise<string> {
  if (!tag || encodeURIComponent(tag) !== tag || [".", ".."].includes(tag)) {
    throw new Error(`Invalid npm dist-tag: ${tag}`);
  }
  const timeout = AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS);
  const response = await fetch(`${PACKAGE_URL}/${encodeURIComponent(tag)}`, {
    headers: {
      accept: "application/json",
      "User-Agent": `yukino/${version} (${process.platform}; ${process.arch})`,
    },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (response.status === 404) {
    throw new Error(`No Yukino release found for npm dist-tag "${tag}".`);
  }
  if (!response.ok) {
    throw new Error(
      `Could not check for Yukino updates (npm dist-tag "${tag}"): HTTP ${response.status}`,
    );
  }
  const data: unknown = await response.json();
  const latest = z.object({ version: z.string() }).parse(data).version;
  if (!semver.valid(latest)) {
    throw new Error(`Invalid package version: ${latest}`);
  }
  return latest;
}

export async function checkForUpdate(
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const latest = await getLatestVersion({ signal });
    return isNewerVersion(latest, version) ? latest : undefined;
  } catch {
    return undefined;
  }
}
