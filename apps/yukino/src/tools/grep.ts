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

import type { Stats } from "node:fs";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { Minimatch } from "minimatch";

import { GREP_DESCRIPTION } from "./descriptions.js";
import {
  SKIP_DIRS,
  type Tool,
  type ToolCategory,
  type ToolContext,
  type ToolResult,
  type ToolSchema,
} from "./types.js";

import { createChildLogger } from "@/logger/index.js";
import { asErrorString, strArg } from "@/utils/index.js";

const log = createChildLogger({ module: "tools" });

const MAX_RESULTS = 500;

// JS regexes keep \w/\b/\d ASCII-only even in u-mode, unlike ripgrep whose
// defaults are Unicode-aware. Rewrite them to property-escape equivalents
// before compiling so "\w+" matches Chinese text and "\b" works next to CJK.
const WORD = "\\p{L}\\p{M}\\p{N}_";
const TOP_LEVEL = new Map<string, string>([
  ["w", `[${WORD}]`],
  ["W", `[^${WORD}]`],
  ["d", "\\p{Nd}"],
  ["D", "\\P{Nd}"],
  ["b", `(?:(?<![${WORD}])(?=[${WORD}])|(?<=[${WORD}])(?![${WORD}]))`],
  ["B", `(?:(?<=[${WORD}])(?=[${WORD}])|(?<![${WORD}])(?![${WORD}]))`],
]);
// Inside a character class \b means backspace and complements (\W/\D) can't
// be inlined without v-flag set operations, so only \w/\d are expanded.
const IN_CLASS = new Map<string, string>([
  ["w", WORD],
  ["d", "\\p{Nd}"],
]);

function toUnicodePattern(pattern: string): string {
  let out = "";
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern.charAt(i);
    if (ch === "\\" && i + 1 < pattern.length) {
      const next = pattern.charAt(i + 1);
      if (next === "x") {
        // ripgrep/PCRE hex escape \x{FFFF} → JS u-mode \u{FFFF}.
        const braced = /^\{([0-9a-fA-F]{1,6})\}/.exec(pattern.slice(i + 2));
        // Values above 0x10FFFF are invalid in both PCRE and JS u-mode; pass
        // them through so compilation fails and the legacy fallback kicks in.
        if (braced && Number.parseInt(braced[1], 16) <= 0x10ffff) {
          out += `\\u${braced[0]}`;
          i += 1 + braced[0].length;
          continue;
        }
      }
      const rep = inClass ? IN_CLASS.get(next) : TOP_LEVEL.get(next);
      out += rep ?? ch + next;
      i++;
      continue;
    }
    if (ch === "[" && !inClass) {
      inClass = true;
    } else if (ch === "]" && inClass) {
      inClass = false;
    }
    out += ch;
  }
  return out;
}

export class GrepTool implements Tool {
  // Use a hardcoded string instead of GrepTool.name.replace("Tool", "")
  // because class names are not stable after minification — bundlers like
  // Terser/esbuild may rename or mangle them, producing incorrect tool names at runtime.
  name = "Grep";

  description = GREP_DESCRIPTION;

  category: ToolCategory = "read";

  schema(): ToolSchema {
    const inputSchema = {
      type: "object" as const,
      properties: {
        pattern: {
          type: "string" as const,
          description:
            "Case-insensitive regular expression matched against each line. Escape backslashes in JSON; use ReadFile for surrounding context.",
        },
        path: {
          type: "string" as const,
          description:
            "Directory or file, absolute or relative to the Agent's working directory (default '.'). Narrow the path to reduce output.",
          default: ".",
        },
        include: {
          type: "string" as const,
          description:
            "Optional filename glob. Bare patterns such as '*.ts' match at any depth; patterns with '/' match paths relative to the Agent's working directory.",
        },
      },
      required: ["pattern"],
    };

    return {
      name: this.name,
      description: this.description,
      input_schema: inputSchema,
    };
  }

  async execute(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    const pattern = strArg(args, "pattern");
    if (!pattern) {
      return {
        output: "Error: pattern is required",
        isError: true,
      };
    }

    const searchPath = resolve(ctx.workDir, strArg(args, "path", ctx.workDir));
    const include = strArg(args, "include");

    let regex: RegExp;
    try {
      regex = new RegExp(toUnicodePattern(pattern), "iu");
    } catch {
      // Accepted compiling (e.g. "interface{" — invalid in u-mode), with the
      // old ASCII \w/\b/\d semantics.
      try {
        regex = new RegExp(pattern, "i");
      } catch (err) {
        log.error({ err }, "tool operation failed");
        return {
          output: `Error: invalid regex pattern: ${pattern}`,
          isError: true,
        };
      }
    }

    // dot:true — the walker below surfaces hidden files, so the include
    // filter must match them too (e.g. include "*.yaml" on .github files).
    // matchBase: bare patterns ("*.ts") match the basename at any depth;
    // patterns with "/" match the workDir-relative path (gitignore/ripgrep
    // semantics, same form as printed results).
    const includeMatcher = include ? new Minimatch(include, { dot: true, matchBase: true }) : null;
    const matchesInclude = (fullPath: string): boolean =>
      includeMatcher === null ||
      includeMatcher.match(relative(ctx.workDir, fullPath).split(sep).join("/"));
    const results: string[] = [];

    const walk = async (dir: string): Promise<void> => {
      if (results.length >= MAX_RESULTS) {
        return;
      }

      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch (err) {
        log.error({ err }, "tool operation failed");
        return;
      }

      for (const entry of entries) {
        if (results.length >= MAX_RESULTS) {
          return;
        }
        if (SKIP_DIRS.has(entry)) {
          continue;
        }
        const fullPath = join(dir, entry);
        let fileStat: Stats;
        try {
          fileStat = await lstat(fullPath);
          if (fileStat.isSymbolicLink()) {
            // Follow file symlinks (old behavior), but never descend into
            // symlinked directories — that is what makes cycles harmless.
            fileStat = await stat(fullPath);
            if (!fileStat.isFile()) {
              continue;
            }
          }
        } catch (err) {
          log.error({ err }, "tool operation failed");
          continue;
        }

        if (fileStat.isDirectory()) {
          await walk(fullPath);
        } else if (fileStat.isFile()) {
          if (!matchesInclude(fullPath)) {
            continue;
          }
          await searchFile(fullPath);
        }
      }
    };

    const searchFile = async (filePath: string): Promise<void> => {
      try {
        const buf = await readFile(filePath);
        // NUL byte in the first 8KB → binary (ripgrep's heuristic); scanning
        // it as UTF-8 would only produce replacement-char garbage matches.
        if (buf.subarray(0, 8192).includes(0)) {
          return;
        }
        const lines = buf.toString("utf-8").split("\n");
        const rel = relative(ctx.workDir, filePath);

        for (let i = 0; i < lines.length && results.length < MAX_RESULTS; i++) {
          if (regex.test(lines[i])) {
            results.push(`${rel}:${String(i + 1)}:${lines[i]}`);
          }
        }
      } catch (err) {
        log.error({ err }, "tool operation failed");
        // skip unreadable files
      }
    };

    try {
      const pathStat = await stat(searchPath);
      if (pathStat.isFile()) {
        await searchFile(searchPath);
      } else {
        await walk(searchPath);
      }
    } catch (err) {
      log.error({ err }, "tool operation failed");
      return {
        output: `Error: ${asErrorString(err)}`,
        isError: true,
      };
    }

    if (results.length === 0) {
      return { output: "No matches found.", isError: false };
    }

    let output = results.join("\n");
    if (results.length >= MAX_RESULTS) {
      output += `\n\n(results truncated at ${String(MAX_RESULTS)} matches)`;
    }
    return { output, isError: false };
  }
}
