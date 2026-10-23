import { cpSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "tsdown";
import type { TsdownPlugin, UserConfig } from "tsdown";
import type * as TypeScript from "typescript";

const __dirname = dirname(fileURLToPath(import.meta.url));
const remoteBrowserDist = join(
  __dirname,
  "..",
  "..",
  "packages",
  "remote-browser",
  "dist",
);

const copyRemoteBrowser = (): void => {
  cpSync(remoteBrowserDist, join(__dirname, "dist", "browser", "dist"), {
    recursive: true,
  });
};

const pkg: unknown = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
);

const pkgVersion: string =
  typeof pkg === "object" &&
  pkg !== null &&
  "version" in pkg &&
  typeof pkg.version === "string"
    ? pkg.version
    : "0.0.0";

// UI-only dependencies: reached exclusively from the terminal layer
// (apps/yukino/src/main.tsx and packages/ui). The library barrel must never
// pull them in, or a consumer embedding the library in a non-terminal host
// would get a terminal-bound graph. `tests/build-guards.test.ts` recomputes
// this set from the actual import sites and fails on drift, so it cannot go
// stale silently. react is included: the barrel no longer re-exports the ui
// package, so react is reached exclusively from the terminal layer. react-dom
// is absent — only the standalone browser bundle (packages/remote-browser,
// own tsup build) imports it, which never enters the CLI/library graph.
const uiOnlyDeps = [
  "ink",
  "ansi-escapes",
  "ansi-regex",
  "chalk",
  "fuse.js",
  "marked",
  "node-emoji",
  "react",
  "shiki",
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

// Modules that must stay external even in the CLI build, which otherwise
// bundles everything (deps.alwaysBundle):
// - @jsquash/* codec modules locate their WASM binaries inside their
//   installed packages.
// - react-devtools-core is a peer dependency of ink that is not installed;
//   it is only reached from ink's devtools entry (ink/build/devtools.js).
//   Keeping it external avoids failing the bundle on an unresolvable import.
// Node.js built-ins need no rule here: platform "node" externalizes them, and
// bundled CJS deps that call bare require("assert") etc. get a real `require`
// through the banner shim below.
const cliRuntimeExternals = [/^@jsquash\//, /^react-devtools-core$/];

const uiDirs = [join(__dirname, "..", "..", "packages", "ui", "src") + sep];

// Library-build guard: the barrel entry (src/index.ts) must never reach the
// terminal layer, neither through a bare ui-only specifier nor through a
// path resolving into packages/ui. Failing the build is the point.
//
// The bare-specifier rule fires because libConfig lists the ui-only packages
// in deps.alwaysBundle: tsdown's internal deps resolver consults this plugin
// through the resolution chain before returning a resolve result, so a
// reachable ui-only package throws here instead of being silently bundled or
// externalized. Relative ids never reach the deps resolver at all, so the
// path-based rule always fires.
const banUIOnlyPlugin: TsdownPlugin = {
  name: "ban-ui-only-deps",
  resolveId(id, importer) {
    const ban = (kind: string): never => {
      throw new Error(
        `[library-build] ${kind} "${id}" (imported by ${importer || "entry"}) must not be reachable from src/index.ts`,
      );
    };
    if (uiOnlyPattern.test(id)) {
      ban("ui-only dependency");
    }
    if (/^@yukino\.js\/ui(\/|$)/.test(id)) {
      ban("UI module");
    }
    if (/^\.\.?\//.test(id) && importer !== undefined) {
      const resolved = resolve(dirname(importer), id);
      if (uiDirs.some((directory) => resolved.startsWith(directory))) {
        ban("UI module");
      }
    }
    return null;
  },
};

// Ambiguous-export scan. When two modules reached through `export *` from the
// barrel export the same name, bundlers drop that name from the output without
// any warning, silently shrinking the published API. tsc reports the same
// situation as TS2308, which is what this scan collects.
//
// It runs once the build finishes (tsdown awaits onSuccess) and reads only
// sources, never dist/lib/index.d.ts, so it is independent of dts emit order.
const AMBIGUOUS_EXPORT_DIAGNOSTIC = 2308;

interface ExportConflict {
  file: string;
  line: number;
  column: number;
  message: string;
}

const findAmbiguousExports = (
  tsconfigPath: string,
  projectRoot: string,
): ExportConflict[] => {
  const nodeRequire = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const ts = nodeRequire("typescript") as typeof TypeScript;

  const read = ts.readConfigFile(tsconfigPath, (path) => ts.sys.readFile(path));
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
  const packagesPrefix = resolve(projectRoot, "..", "..", "packages") + sep;
  const conflicts: ExportConflict[] = [];
  for (const sourceFile of program.getSourceFiles()) {
    if (
      sourceFile.isDeclarationFile ||
      (!sourceFile.fileName.startsWith(srcPrefix) &&
        !sourceFile.fileName.startsWith(packagesPrefix))
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

// tsdown runs the clean sweep once for all configs before any build starts,
// so both configs can enable `clean` without racing over each other's outDir.
const cliConfig: UserConfig = {
  name: "cli",
  entry: {
    main: "src/cli.ts",
    "image-worker": "../../packages/images/src/image-worker.js",
  },
  format: ["esm"],
  env: {
    NODE_ENV: "production",
  },
  platform: "node",
  target: "node20",
  outDir: "dist",
  clean: true,
  minify: true,
  // The CLI ships no types and the bin entry is dist/main.js ("type":
  // "module"), so: no dts (package.json "types" would auto-enable it for
  // every config otherwise) and .js, not .mjs.
  dts: false,
  fixedExtension: false,
  sourcemap: false,
  banner: {
    js: [
      "#!/usr/bin/env node",
      // Provide a real `require` for bundled CJS modules (e.g. signal-exit)
      // that call require("assert") etc. — the CJS-to-ESM interop checks
      // `typeof require !== "undefined"` and will use this instead of throwing.
      'import { createRequire as __yukinoCreateRequire } from "node:module";',
      "const require = __yukinoCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  deps: {
    // Bundle everything (the CLI ships self-contained) except the runtime
    // externals above.
    alwaysBundle: (id) =>
      !cliRuntimeExternals.some((pattern) => pattern.test(id)),
    neverBundle: cliRuntimeExternals,
  },
  define: { __YUKINO_VERSION__: JSON.stringify(pkgVersion) },
  tsconfig: "tsconfig.json",
  onSuccess: () => {
    copyRemoteBrowser();
  },
};

// Library entry: keeps dependencies external (consumers resolve them from their
// own node_modules), emits bundled d.ts, and must never reach src/ui. outDir is
// nested under dist/ so the two builds' chunk graphs never overwrite each other.
const libConfig: UserConfig = {
  name: "lib",
  entry: {
    index: "src/index.ts",
    "image-worker": "../../packages/images/src/image-worker.js",
  },
  format: ["esm"],
  platform: "node",
  target: "node20",
  env: {
    NODE_ENV: "production",
  },
  outDir: "dist/lib",
  clean: true,
  minify: false,
  // build: run the dts emit through the TS solution builder with a single
  // program covering src + all bundled workspace packages (tsconfig.dts.json).
  // The plugin's default lazy mode silently drops declarations for files
  // outside the app rootDir (MISSING_EXPORT on names re-exported through
  // `export *`), and eager mode creates one program per module and OOMs.
  dts: { build: true },
  // Library exports map to ./dist/lib/index.js + index.d.ts, not .mjs/.d.mts.
  fixedExtension: false,
  sourcemap: false,
  tsconfig: "tsconfig.dts.json",
  define: { __YUKINO_VERSION__: JSON.stringify(pkgVersion) },
  // tsdown externalizes every production dependency (dependencies,
  // optionalDependencies, peerDependencies) by default, which is what the
  // library build wants: consumers resolve them from their own node_modules.
  // optionalDependencies (the telemetry stack) are loaded lazily behind a
  // guarded dynamic import and degrade to a noop runtime when absent —
  // bundling them would defeat their optionality, so the default keeps them
  // external. The ui-only packages must instead reach banUIOnlyPlugin, so a
  // reachable ui-only package fails the build instead of being silently kept
  // as an external import. Workspace packages (@yukino.js/*) are source-level
  // and always bundled, so the ban plugin and the dts rollup see the full
  // workspace graph.
  deps: {
    alwaysBundle: [uiOnlyPattern, /^@yukino\.js\//],
  },
  plugins: [banUIOnlyPlugin],
  onSuccess: () => {
    assertNoAmbiguousExports();
  },
};

export default defineConfig([cliConfig, libConfig]);

// Exported for tests/build-guards.test.ts, which asserts the declared set still
// matches the import sites and that the scan detects an injected conflict.
export { findAmbiguousExports, uiOnlyDeps, uiOnlyPattern };
