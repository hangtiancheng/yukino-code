import { readFileSync } from "node:fs";

import { z } from "zod";

declare const __YUKINO_VERSION__: string | undefined;

const PackageJsonSchema = z.object({
  version: z.string(),
});

function resolveVersion(): string {
  if (typeof __YUKINO_VERSION__ !== "undefined") {
    return __YUKINO_VERSION__;
  }
  const raw: unknown = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf-8"),
  );
  return PackageJsonSchema.parse(raw).version;
}

export const version: string = resolveVersion();
