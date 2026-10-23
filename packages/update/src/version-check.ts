import { version } from "@yukino.js/version";
import { z } from "zod";

import {
  DEFAULT_DIST_TAG,
  PACKAGE_URL,
  REGISTRY_FETCH_TIMEOUT_MS,
  VERSION_PATTERN,
} from "./constants.js";

function parseVersion(value: string) {
  const match = VERSION_PATTERN.exec(value);
  const prerelease = match?.[4]?.split(".") ?? [];
  if (!match || prerelease.some((part) => /^0\d+$/u.test(part))) {
    throw new Error(`Invalid package version: ${value}`);
  }
  return {
    core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
    prerelease,
  };
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const left = parseVersion(candidate);
  const right = parseVersion(current);
  for (let index = 0; index < left.core.length; index++) {
    if (left.core[index] !== right.core[index]) {
      return left.core[index] > right.core[index];
    }
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === 0 && right.prerelease.length > 0;
  }
  for (
    let index = 0;
    index < Math.max(left.prerelease.length, right.prerelease.length);
    index++
  ) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === b) {
      continue;
    }
    if (a === undefined || b === undefined) {
      return b === undefined;
    }
    const aNumeric = /^\d+$/u.test(a);
    const bNumeric = /^\d+$/u.test(b);
    if (aNumeric && bNumeric) {
      return BigInt(a) > BigInt(b);
    }
    return aNumeric === bNumeric ? a > b : bNumeric;
  }
  return false;
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
  parseVersion(latest);
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
