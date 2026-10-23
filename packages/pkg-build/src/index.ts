// Shared tsdown build configuration for @yukino.js/* workspace packages.
//
// Packages consume this through a tiny `tsdown.config.ts`:
//
//   import { definePkgBuild } from "@yukino.js/pkg-build";
//   export default definePkgBuild();
//
// Conventions:
// - Every file under src/ becomes its own entry, preserving relative
//   imports and worker locations in local dist/ builds.
// - ESM-only output (the workspace is `"type": "module"`), Node 20 target.
// - Runtime dependencies stay external; consumers resolve them from their
//   own node_modules when loading these local builds.
// - Declarations are emitted next to the JS for local build verification.
import { readFileSync } from "node:fs";

import type { UserConfig } from "tsdown";

export interface PkgBuildOverrides {
  /**
   * Replace the conventional `src/**` entry glob (e.g. to add non-TS
   * runtime files such as worker scripts).
   */
  entry?: UserConfig["entry"];
  /** Extra esbuild-style defines merged after the defaults. */
  define?: Record<string, string>;
}

export const definePkgBuild = (
  overrides: PkgBuildOverrides = {},
): UserConfig => {
  // `packages/version` reads __YUKINO_VERSION__ when it is defined; inject
  // the consuming package's own version (in dev, when exports point at src/,
  // the identifier stays undefined and the version is read from disk).
  let define: Record<string, string> | undefined;
  try {
    const raw: unknown = JSON.parse(readFileSync("package.json", "utf-8"));
    if (
      typeof raw === "object" &&
      raw !== null &&
      "version" in raw &&
      typeof raw.version === "string"
    ) {
      define = { __YUKINO_VERSION__: JSON.stringify(raw.version) };
    }
  } catch {
    // No readable package.json — skip the define.
  }

  return {
    entry: ["src/**/*.ts", "src/**/*.tsx", "!src/**/*.d.ts"],
    format: ["esm"],
    platform: "node",
    target: "node20",
    outDir: "dist",
    clean: true,
    dts: true,
    // tsdown defaults `fixedExtension` to true for platform: "node" which
    // emits .mjs/.d.mts. Emit .js/.d.ts to match source import specifiers.
    fixedExtension: false,
    define: { ...define, ...overrides.define },
    ...(overrides.entry ? { entry: overrides.entry } : {}),
  };
};
