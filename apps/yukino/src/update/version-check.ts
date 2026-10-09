import { z } from "zod";

import { version } from "@/version.js";

export const PACKAGE_NAME = "@yukino.js/yukino";
const PACKAGE_URL = "https://registry.npmjs.org/@yukino.js%2Fyukino";
const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*))?(?:\+[\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*)?$/u;

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
  tag = "latest",
  signal,
}: {
  tag?: string;
  signal?: AbortSignal;
} = {}): Promise<string> {
  if (!tag || encodeURIComponent(tag) !== tag || [".", ".."].includes(tag)) {
    throw new Error(`Invalid npm dist-tag: ${tag}`);
  }
  const timeout = AbortSignal.timeout(10_000);
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
  if (process.env.YUKINO_SKIP_VERSION_CHECK === "1") {
    return undefined;
  }
  try {
    const latest = await getLatestVersion({ signal });
    return isNewerVersion(latest, version) ? latest : undefined;
  } catch {
    return undefined;
  }
}
