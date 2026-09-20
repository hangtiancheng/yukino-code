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

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { uiOnlyPattern } from "../tsup.config.js";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const libDir = join(pkgRoot, "dist", "lib");
const libEntry = join(libDir, "index.js");
const cliEntry = join(pkgRoot, "dist", "main.js");

// Module specifiers quoted in import/export statements (including dynamic import).
const moduleSpecifier = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
// JSDoc examples may quote specifiers that are not real dependencies.
const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("cli entry (dist/main.js)", () => {
  it("keeps the shebang for the bin target", () => {
    expect(existsSync(cliEntry)).toBe(true);
    expect(
      readFileSync(cliEntry, "utf-8").startsWith("#!/usr/bin/env node"),
    ).toBe(true);
  });
});

describe.skipIf(!existsSync(libEntry))("library entry (dist/lib)", () => {
  it("imports no ui-only dependency or src/ui module", () => {
    for (const file of readdirSync(libDir)) {
      if (!file.endsWith(".js") && !file.endsWith(".d.ts")) {
        continue;
      }
      const code = stripComments(readFileSync(join(libDir, file), "utf-8"));
      for (const [, specifier] of code.matchAll(moduleSpecifier)) {
        expect(
          uiOnlyPattern.test(specifier),
          `${file} must not import the ui-only dependency "${specifier}"`,
        ).toBe(false);
        expect(
          specifier.startsWith("@/ui"),
          `${file} must not import the UI layer via "${specifier}"`,
        ).toBe(false);
      }
    }
  });

  it("leaks no unresolved @/ type imports", () => {
    for (const file of readdirSync(libDir)) {
      if (!file.endsWith(".d.ts")) {
        continue;
      }
      const code = stripComments(readFileSync(join(libDir, file), "utf-8"));
      expect(
        /["']@\/[^"']*["']/.exec(code),
        `${file} must not leak unresolved @/ type imports`,
      ).toBeNull();
    }
  });

  it("loads in plain node and exposes the agent API", () => {
    const scriptFile = fileURLToPath(
      new URL("./library-entry-script.js", import.meta.url),
    );
    const stdout = execFileSync(process.execPath, [scriptFile], {
      env: { ...process.env, YUKINO_LIB_ENTRY: pathToFileURL(libEntry).href },
      encoding: "utf-8",
    });

    const LoadedSchema = z.object({
      totalExports: z.number().int().positive(),
      version: z.string().regex(/^\d+\.\d+/),
      symbols: z.record(z.string(), z.string()),
    });
    const parsed = LoadedSchema.safeParse(JSON.parse(stdout));
    expect(parsed.success, stdout).toBe(true);
    if (!parsed.success) {
      return;
    }
    // One namespace per source directory (plus the root-file namespaces), so
    // the top level is small by design; the symbols check probes deep paths.
    expect(parsed.data.totalExports).toBeGreaterThan(30);
    for (const [name, type] of Object.entries(parsed.data.symbols)) {
      expect(type, name).toBe("function");
    }
  });
});
