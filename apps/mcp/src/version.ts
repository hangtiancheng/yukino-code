// Resolve the package version: tsup injects __YUKINO_MCP_VERSION__ at build
// time; in dev (tsx) we walk up from this file to read package.json.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

declare const __YUKINO_MCP_VERSION__: string | undefined;

const PackageJsonSchema = z.object({
  version: z.string(),
});

function resolveVersion(): string {
  if (typeof __YUKINO_MCP_VERSION__ !== "undefined") {
    return __YUKINO_MCP_VERSION__;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Try both 1 and 2 levels up to cover src/ and dist/ layouts.
  for (const levels of ["..", "../.."]) {
    const candidate = path.resolve(here, levels, "package.json");
    try {
      const raw: unknown = JSON.parse(readFileSync(candidate, "utf-8"));
      const parsed = PackageJsonSchema.safeParse(raw);
      if (parsed.success) {
        return parsed.data.version;
      }
    } catch {
      // continue
    }
  }
  throw new Error("Could not resolve package version");
}

export const version: string = resolveVersion();
