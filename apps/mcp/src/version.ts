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

// Resolve the package version: tsup injects __YUKINO_MCP_VERSION__ at build
// time; in dev (tsx) we walk up from this file to read package.json.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

declare const __YUKINO_MCP_VERSION__: string | undefined;

const PackageJsonSchema = z.looseObject({
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
