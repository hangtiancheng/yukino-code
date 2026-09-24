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

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import pkg from "../package.json";
import {
  findAmbiguousExports,
  uiOnlyDeps,
  uiOnlyPattern,
} from "../tsup.config.js";

const appRoot = join(import.meta.dirname, "..");
const srcRoot = join(appRoot, "src");
const dependencyNames = Object.keys(pkg.dependencies);

/**
 * Recompute the ui-only set from the sources: a dependency is ui-only
 * when every module importing it belongs to the terminal layer (src/main.tsx and
 * src/ui/**). Type-only imports are ignored — they are erased and cannot make a
 * package reachable at runtime.
 */
const deriveUIOnlyDeps = (): string[] => {
  const importSites = new Map<string, Set<string>>();

  const visit = (file: string): void => {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.ESNext,
    );
    const relativePath = file.slice(appRoot.length + 1).replaceAll("\\", "/");
    const specifiers: string[] = [];
    const collect = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) {
        const isTypeOnlyImport =
          node.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword;
        if (!isTypeOnlyImport && ts.isStringLiteral(node.moduleSpecifier)) {
          specifiers.push(node.moduleSpecifier.text);
        }
      } else if (
        ts.isExportDeclaration(node) &&
        !node.isTypeOnly &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        specifiers.push(node.moduleSpecifier.text);
      } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
        const [firstArgument] = node.arguments;
        const isDynamicImport =
          node.expression.kind === ts.SyntaxKind.ImportKeyword;
        const isRequireCall =
          ts.isIdentifier(node.expression) &&
          node.expression.text === "require";
        if (
          ts.isStringLiteral(firstArgument) &&
          (isDynamicImport || isRequireCall)
        ) {
          specifiers.push(firstArgument.text);
        }
      }
      ts.forEachChild(node, collect);
    };
    collect(source);

    for (const specifier of specifiers) {
      const dependency = dependencyNames.find(
        (name) => specifier === name || specifier.startsWith(`${name}/`),
      );
      if (!dependency) {
        continue;
      }
      const sites = importSites.get(dependency) ?? new Set<string>();
      sites.add(relativePath);
      importSites.set(dependency, sites);
    }
  };

  // src/remote/fe is a standalone browser bundle with its own tsup build
  // (`pnpm build:fe`), served as static assets by the remote server. It is
  // never part of the CLI/library import graph, so its imports (react,
  // react-dom, dompurify, marked) must not count as import sites here.
  const fePrefix = "src/remote/fe/";

  const walk = (directory: string): void => {
    for (const entry of ts.sys.readDirectory(directory, [".ts", ".tsx"])) {
      const relativeEntry = entry
        .slice(appRoot.length + 1)
        .replaceAll("\\", "/");
      if (relativeEntry.startsWith(fePrefix)) {
        continue;
      }
      visit(entry);
    }
  };
  walk(srcRoot);

  const isTerminalLayer = (path: string): boolean =>
    path.startsWith("src/ui/") || path === "src/main.tsx";

  return dependencyNames
    .filter((dependency) => {
      const sites = importSites.get(dependency);
      return (
        sites !== undefined &&
        sites.size > 0 &&
        [...sites].every(isTerminalLayer)
      );
    })
    .sort();
};

describe("library build ui-only dependency guard", () => {
  it("declares every entry as a real dependency", () => {
    const undeclared = uiOnlyDeps.filter(
      (dependency) => !dependencyNames.includes(dependency),
    );
    expect(undeclared).toEqual([]);
  });

  it("matches the set derived from the actual import sites", () => {
    expect(deriveUIOnlyDeps()).toEqual([...uiOnlyDeps].sort());
  });

  it("matches a ui-only package and its subpaths only", () => {
    expect(uiOnlyPattern.test("ink")).toBe(true);
    expect(uiOnlyPattern.test("ink/build/devtools.js")).toBe(true);
    expect(uiOnlyPattern.test("chalk")).toBe(true);
    expect(uiOnlyPattern.test("chalk/source/index.js")).toBe(true);
    expect(uiOnlyPattern.test("fuse.js")).toBe(true);
    // Prefixes of a listed name are different packages.
    expect(uiOnlyPattern.test("ink-foo")).toBe(false);
    expect(uiOnlyPattern.test("chalkboard")).toBe(false);
  });

  it("bans react and keeps server-safe dependencies out of the ban", () => {
    // The barrel does not re-export src/ui, so react and marked are reached
    // exclusively from the terminal layer and are banned like the other
    // ui-only deps.
    for (const specifier of ["react", "react/jsx-runtime", "marked"]) {
      expect(uiOnlyPattern.test(specifier)).toBe(true);
    }
    expect(uiOnlyDeps).toContain("react");
    expect(uiOnlyDeps).toContain("marked");
    // react-dom is imported only by the standalone browser bundle
    // (src/remote/fe), never by the node graph — it is not part of the set.
    for (const specifier of [
      "react-dom",
      "react-dom/client",
      "zod",
      "@anthropic-ai/sdk",
      "koa",
      "sharp",
      "ws",
    ]) {
      expect(uiOnlyPattern.test(specifier)).toBe(false);
    }
    expect(uiOnlyDeps).not.toContain("react-dom");
  });
});

describe("ambiguous-export scan", () => {
  const withTempProject = (
    files: Record<string, string>,
    run: (root: string) => void,
  ): void => {
    const root = mkdtempSync(join(tmpdir(), "yukino-guard-"));
    try {
      for (const [path, contents] of Object.entries(files)) {
        const target = join(root, path);
        mkdirSync(join(target, ".."), { recursive: true });
        writeFileSync(target, contents);
      }
      run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  const tsconfig = JSON.stringify({
    compilerOptions: {
      module: "esnext",
      moduleResolution: "bundler",
      target: "esnext",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
    },
    include: ["src"],
  });

  it("detects a name exported by two `export *` sources", () => {
    withTempProject(
      {
        "tsconfig.json": tsconfig,
        "src/a.ts": "export const dup = 1;\n",
        "src/b.ts": "export const dup = 2;\n",
        "src/index.ts": 'export * from "./a.js";\nexport * from "./b.js";\n',
      },
      (root) => {
        const conflicts = findAmbiguousExports(
          join(root, "tsconfig.json"),
          root,
        );
        expect(conflicts).toHaveLength(1);
        expect(conflicts[0]?.file).toBe("src/index.ts");
        expect(conflicts[0]?.message).toContain(
          "already exported a member named 'dup'",
        );
      },
    );
  });

  it("accepts the same symbol re-exported through two paths", () => {
    withTempProject(
      {
        "tsconfig.json": tsconfig,
        "src/a.ts": "export const shared = 1;\n",
        "src/b.ts": 'export * from "./a.js";\n',
        "src/index.ts": 'export * from "./a.js";\nexport * from "./b.js";\n',
      },
      (root) => {
        expect(findAmbiguousExports(join(root, "tsconfig.json"), root)).toEqual(
          [],
        );
      },
    );
  });

  it("reports no conflict for the published barrel", () => {
    expect(
      findAmbiguousExports(join(appRoot, "tsconfig.build.json"), appRoot),
    ).toEqual([]);
  });
});
