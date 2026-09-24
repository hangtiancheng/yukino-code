/**
 * Copyright (c) 2026 hangtiancheng
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";
import type { Options } from "tsup";

// tsup does not re-export the esbuild Plugin type used by `esbuildPlugins`;
// recover it from the Options type so standalone plugin consts stay typed.
type EsbuildPlugin = NonNullable<Options["esbuildPlugins"]>[number];

const __dirname = dirname(fileURLToPath(import.meta.url));

const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
) as {
  version: string;
  dependencies?: Record<string, string>;
};

// UI-only dependencies: reached exclusively from the terminal layer
// (src/main.tsx and src/ui/**). The library barrel must never pull them in, or
// a consumer embedding the library in a non-terminal host would get a
// terminal-bound graph. `tests/build-guards.test.ts` recomputes this set from
// the actual import sites and fails on drift, so it cannot go stale silently.
// react is included: the barrel no longer re-exports src/ui, so react is
// reached exclusively from the terminal layer. react-dom is absent — only the
// standalone browser bundle (src/remote/fe, own tsup build) imports it, which
// never enters the CLI/library graph.
const uiOnlyDeps = [
  "ink",
  "ansi-escapes",
  "ansi-regex",
  "chalk",
  "cli-highlight",
  "cli-table3",
  "fuse.js",
  "marked",
  "node-emoji",
  "react",
  "slice-ansi",
  "string-width",
  "supports-hyperlinks",
  "wrap-ansi",
];

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Matches the package itself and any subpath ("chalk" and "chalk/source/index.js").
const uiOnlyPattern = new RegExp(
  `^(?:${uiOnlyDeps.map(escapeRegExp).join("|")})(?:/|$)`,
);
const uiOnlySet = new Set<string>(uiOnlyDeps);

// CLI build bundles everything (noExternal), so CJS deps (e.g. signal-exit)
// use bare require("assert") which esbuild can't shim in ESM output —
// externalize all Node.js built-ins instead.
const externalizeNodeBuiltinsPlugin: EsbuildPlugin = {
  name: "externalize-node-builtins",
  setup(build) {
    const re = new RegExp(`^(${builtinModules.join("|")})(/.*)?$`);
    build.onResolve({ filter: re }, (args) => ({
      path: args.path,
      external: true,
    }));
    // Native modules and packages with runtime assets must stay external so
    // their binaries and companion files remain resolvable from node_modules.
    build.onResolve(
      {
        filter: /^(?:sharp|@anthropic-ai\/sandbox-runtime)(?:\/|$)/,
      },
      (args) => ({
        path: args.path,
        external: true,
      }),
    );
    // Not referenced by src/: ink itself requires it from its devtools entry
    // (ink/build/devtools.js) and declares it a peer dependency. Since the CLI
    // build bundles ink, the resolution happens here, and the peer is not
    // installed — keep it external instead of failing the bundle.
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: "react-devtools-core",
      external: true,
    }));
  },
};

const uiDirs = [join(__dirname, "src", "ui") + sep];

// Vite-style `?raw` imports: load the file
// as a default-exported string, mirroring Vite/Vitest behavior.
const rawImportPlugin: EsbuildPlugin = {
  name: "raw-import",
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: resolve(dirname(args.importer), args.path.replace(/\?raw$/, "")),
      namespace: "raw-import",
    }));
    build.onLoad({ filter: /.*/, namespace: "raw-import" }, async (args) => ({
      contents: await readFile(args.path, "utf8"),
      loader: "text",
    }));
  },
};

// Library-build guard: the barrel entry (src/index.ts) must never reach the
// terminal layer, neither through a bare ui-only specifier nor through a
// path resolving into src/ui. Failing the build is the point.
//
// The bare-specifier rule only fires because libConfig lists the ui-only
// packages in `noExternal`: tsup registers its own resolver ahead of user
// plugins and auto-externalizes every `dependencies` entry, so without
// `noExternal` those requests are resolved as external before this plugin sees
// them and the guard degrades to dead code.
const banUIOnlyPlugin: EsbuildPlugin = {
  name: "ban-ui-only-deps",
  setup(build) {
    const ban = (importer: string, path: string, kind: string): never => {
      throw new Error(
        `[library-build] ${kind} "${path}" (imported by ${importer || "entry"}) must not be reachable from src/index.ts`,
      );
    };
    build.onResolve({ filter: uiOnlyPattern }, (args) =>
      ban(args.importer, args.path, "ui-only dependency"),
    );
    build.onResolve({ filter: /^@\/ui(\/|$)/ }, (args) =>
      ban(args.importer, args.path, "UI module"),
    );
    build.onResolve({ filter: /^\.\.?\// }, (args) => {
      const resolved = resolve(dirname(args.importer), args.path);
      if (uiDirs.some((directory) => resolved.startsWith(directory))) {
        ban(args.importer, args.path, "UI module");
      }
      return undefined;
    });
  },
};

// Ambiguous-export scan. When two modules reached through `export *` from the
// barrel export the same name, esbuild drops that name from the output without
// any warning, silently shrinking the published API. tsc reports the same
// situation as TS2308, which is what this scan collects.
//
// It runs once the bundle is written (tsup awaits onSuccess inside the build)
// and reads only sources, never dist/lib/index.d.ts: tsup runs the dts worker
// concurrently, so the declaration file is not guaranteed to exist yet.
const AMBIGUOUS_EXPORT_DIAGNOSTIC = 2308;

type ExportConflict = {
  file: string;
  line: number;
  column: number;
  message: string;
};

const findAmbiguousExports = (
  tsconfigPath: string,
  projectRoot: string,
): ExportConflict[] => {
  const nodeRequire = createRequire(import.meta.url);
  const ts = nodeRequire("typescript") as typeof import("typescript");

  const read = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (read.error) {
    throw new Error(
      `[library-build] cannot read ${tsconfigPath}: ${ts.flattenDiagnosticMessageText(read.error.messageText, " ")}`,
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    projectRoot,
  );
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
  });

  const srcPrefix = join(projectRoot, "src") + sep;
  const conflicts: ExportConflict[] = [];
  for (const sourceFile of program.getSourceFiles()) {
    if (
      sourceFile.isDeclarationFile ||
      !sourceFile.fileName.startsWith(srcPrefix)
    ) {
      continue;
    }
    for (const diagnostic of program.getSemanticDiagnostics(sourceFile)) {
      if (diagnostic.code !== AMBIGUOUS_EXPORT_DIAGNOSTIC) {
        continue;
      }
      const position = sourceFile.getLineAndCharacterOfPosition(
        diagnostic.start ?? 0,
      );
      conflicts.push({
        file: relative(projectRoot, sourceFile.fileName),
        line: position.line + 1,
        column: position.character + 1,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
      });
    }
  }
  return conflicts;
};

const assertNoAmbiguousExports = (): void => {
  const conflicts = findAmbiguousExports(
    join(__dirname, "tsconfig.build.json"),
    __dirname,
  );
  if (conflicts.length === 0) {
    console.log(
      "[library-build] ambiguous-export scan: no conflicting `export *` names",
    );
    return;
  }
  throw new Error(
    [
      "[library-build] ambiguous exports — a name exported by two `export *` sources is dropped from the bundle without warning:",
      ...conflicts.map(
        (conflict) =>
          `  ${conflict.file}:${conflict.line}:${conflict.column} ${conflict.message}`,
      ),
      "  Resolve each one with an explicit named re-export in src/index.ts.",
    ].join("\n"),
  );
};

// CLI entry: fully bundled, minified single-graph output with a shebang so the
// `yukino` bin is self-contained. `!lib/**` keeps its clean sweep out of the
// library output below — tsup runs an array config concurrently, so a `**/*`
// sweep here races with, and can delete, dist/lib.
const cliConfig: Options = {
  entry: ["src/main.tsx"],
  format: ["esm"],
  env: {
    NODE_ENV: "production",
  },
  platform: "node",
  target: "node20",
  outDir: "dist",
  clean: ["!lib/**"],
  minify: true,
  banner: {
    js: [
      "#!/usr/bin/env node",
      // Provide a real `require` for bundled CJS modules (e.g. signal-exit)
      // that call require("assert") etc. esbuild's CJS-to-ESM shim checks
      // `typeof require !== "undefined"` and will use this instead of throwing.
      'import { createRequire as __yukinoCreateRequire } from "node:module";',
      "const require = __yukinoCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  noExternal: [/.*/],
  define: { __YUKINO_VERSION__: JSON.stringify(pkg.version) },
  tsconfig: "tsconfig.json",
  esbuildPlugins: [rawImportPlugin, externalizeNodeBuiltinsPlugin],
};

// Library entry: keeps dependencies external (consumers resolve them from their
// own node_modules), emits bundled d.ts, and must never reach src/ui. outDir is
// nested under dist/ so the two builds' chunk graphs never overwrite each other.
const libConfig: Options = {
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  env: {
    NODE_ENV: "production",
  },
  outDir: "dist/lib",
  clean: true,
  minify: false,
  splitting: true,
  dts: true,
  tsconfig: "tsconfig.build.json",
  define: { __YUKINO_VERSION__: JSON.stringify(pkg.version) },
  // Runtime dependencies stay external, except the ui-only ones: those
  // must reach banUIOnlyPlugin, so a reachable ui-only package fails
  // the build instead of being silently kept as an external import.
  external: [...Object.keys(pkg.dependencies ?? {})].filter(
    (dep) => !uiOnlySet.has(dep),
  ),
  noExternal: [uiOnlyPattern],
  esbuildPlugins: [
    rawImportPlugin,
    externalizeNodeBuiltinsPlugin,
    banUIOnlyPlugin,
  ],
  onSuccess: async () => {
    assertNoAmbiguousExports();
  },
};

export default defineConfig([cliConfig, libConfig]);

// Exported for tests/build-guards.test.ts, which asserts the declared set still
// matches the import sites and that the scan detects an injected conflict.
export {
  findAmbiguousExports,
  uiOnlyDeps as uiOnlyDeps,
  uiOnlyPattern as uiOnlyPattern,
};
