import type { Dir, Stats } from "node:fs";
import { lstat, open, opendir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { Minimatch } from "minimatch";

import { GREP_DESCRIPTION } from "./descriptions.js";
import { SearchOutput } from "./search-output.js";
import { takeUtf8Prefix } from "./shell-output.js";
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
import { resolveToolPath } from "@/utils/paths.js";

const log = createChildLogger({ module: "tools" });

const MAX_RESULTS = 500;
const MAX_MATCH_LINE_BYTES = 2000;
const BINARY_SNIFF_BYTES = 8 * 1024;
const DEFAULT_MAX_TRAVERSED_ENTRIES = 10_000;
const DEFAULT_MAX_TRAVERSAL_DEPTH = 25;
// Files above this size are skipped rather than buffered whole: reading a
// multi-GB file into memory would spike it and block the loop, and the 500-
// match cap means huge files rarely contribute anything the model needs.
const MAX_GREP_FILE_BYTES = 25 * 1024 * 1024;

export interface GrepTraversalLimits {
  maxEntries: number;
  maxDepth: number;
}

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

  constructor(
    private readonly traversalLimits: GrepTraversalLimits = {
      maxEntries: DEFAULT_MAX_TRAVERSED_ENTRIES,
      maxDepth: DEFAULT_MAX_TRAVERSAL_DEPTH,
    },
  ) {}

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

  async execute(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    if (ctx.abortSignal?.aborted) {
      return { output: "Error: operation interrupted", isError: true };
    }
    const pattern = strArg(args, "pattern");
    if (!pattern) {
      return {
        output: "Error: pattern is required",
        isError: true,
      };
    }

    const searchPath = resolveToolPath(ctx.cwd, strArg(args, "path", ctx.cwd));
    const include = strArg(args, "include");

    let regex: RegExp;
    try {
      regex = new RegExp(toUnicodePattern(pattern), "iu");
    } catch {
      // Fallback for patterns u-mode rejects (e.g. "interface{" — a lone "{"
      // is an error in u-mode): compile without u, keeping the old ASCII
      // \w/\b/\d semantics.
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
    // patterns with "/" match the cwd-relative path (gitignore/ripgrep
    // semantics, same form as printed results).
    const includeMatcher = include
      ? new Minimatch(include, { dot: true, matchBase: true })
      : null;
    const matchesInclude = (fullPath: string): boolean =>
      includeMatcher === null ||
      includeMatcher.match(relative(ctx.cwd, fullPath).split(sep).join("/"));
    const results = new SearchOutput(MAX_RESULTS);
    let shortenedLines = 0;
    let skippedLargeFiles = 0;
    let traversedEntries = 0;
    let entryLimitReached = false;
    let depthLimitReached = false;

    const searchFile = async (
      filePath: string,
      knownStat?: Stats,
    ): Promise<void> => {
      ctx.abortSignal?.throwIfAborted();
      try {
        const fileStat = knownStat ?? (await stat(filePath));
        if (fileStat.size > MAX_GREP_FILE_BYTES) {
          skippedLargeFiles++;
          return;
        }

        const file = await open(filePath, "r");
        try {
          ctx.abortSignal?.throwIfAborted();
          // Sniff before buffering the full file. A NUL byte in the first 8 KiB
          // marks it as binary (ripgrep's heuristic), avoiding a needless large
          // allocation for binary files that are still under the 25 MiB gate.
          const sniffLength = Math.min(fileStat.size, BINARY_SNIFF_BYTES);
          const sniff = Buffer.alloc(sniffLength);
          const { bytesRead } = await file.read(sniff, 0, sniffLength, 0);
          if (sniff.subarray(0, bytesRead).includes(0)) {
            return;
          }

          const buf = await file.readFile({ signal: ctx.abortSignal });
          ctx.abortSignal?.throwIfAborted();
          const lines = buf.toString("utf-8").split("\n");
          const rel = relative(ctx.cwd, filePath);

          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              const preview = takeUtf8Prefix(lines[i], MAX_MATCH_LINE_BYTES);
              const shortened = preview.length < lines[i].length;
              if (
                !results.append(
                  `${rel}:${String(i + 1)}:${preview}${shortened ? "…" : ""}`,
                )
              ) {
                break;
              }
              shortenedLines += Number(shortened);
            }
          }
        } finally {
          await file.close();
        }
      } catch (err) {
        ctx.abortSignal?.throwIfAborted();
        log.error({ err }, "tool operation failed");
        // skip unreadable files
      }
    };

    const walk = async (dir: string, depth: number): Promise<void> => {
      ctx.abortSignal?.throwIfAborted();
      if (results.limit || entryLimitReached) {
        return;
      }

      let entries: Dir;
      try {
        entries = await opendir(dir);
      } catch (err) {
        ctx.abortSignal?.throwIfAborted();
        log.error({ err }, "tool operation failed");
        return;
      }

      try {
        for await (const entry of entries) {
          ctx.abortSignal?.throwIfAborted();
          if (results.limit || entryLimitReached) {
            return;
          }
          if (traversedEntries >= this.traversalLimits.maxEntries) {
            entryLimitReached = true;
            return;
          }
          traversedEntries++;
          if (SKIP_DIRS.has(entry.name)) {
            continue;
          }
          const fullPath = join(dir, entry.name);
          let fileStat: Stats;
          try {
            fileStat = await lstat(fullPath);
            if (fileStat.isSymbolicLink()) {
              // Follow file symlinks, but never descend into symlinked
              // directories — that is what makes cycles harmless.
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
            if (depth >= this.traversalLimits.maxDepth) {
              depthLimitReached = true;
              continue;
            }
            await walk(fullPath, depth + 1);
          } else if (fileStat.isFile() && matchesInclude(fullPath)) {
            await searchFile(fullPath, fileStat);
          }
        }
      } catch (err) {
        ctx.abortSignal?.throwIfAborted();
        log.error({ err }, "tool operation failed");
      }
    };

    try {
      const pathStat = await stat(searchPath);
      if (pathStat.isFile()) {
        await searchFile(searchPath, pathStat);
      } else {
        await walk(searchPath, 0);
      }
      ctx.abortSignal?.throwIfAborted();
    } catch (err) {
      log.error({ err }, "tool operation failed");
      return {
        output: ctx.abortSignal?.aborted
          ? "Error: operation interrupted"
          : `Error: ${asErrorString(err)}`,
        isError: true,
      };
    }

    const notices: string[] = [];
    if (results.limit === "matches") {
      notices.push(`results truncated at ${String(MAX_RESULTS)} matches`);
    }
    if (results.limit === "bytes") {
      notices.push(
        "results truncated at 50KB; narrow the path, pattern or include filter",
      );
    }
    if (shortenedLines > 0) {
      notices.push(
        `${String(shortenedLines)} long matching line(s) shortened to 2000 bytes; use ReadFile for full lines`,
      );
    }
    if (entryLimitReached) {
      notices.push(
        `search truncated after visiting ${String(this.traversalLimits.maxEntries)} entries`,
      );
    }
    if (depthLimitReached) {
      notices.push(
        `search truncated: directories deeper than ${String(this.traversalLimits.maxDepth)} levels were skipped`,
      );
    }
    if (skippedLargeFiles > 0) {
      notices.push(
        `${String(skippedLargeFiles)} file(s) over 25MB were skipped`,
      );
    }

    let output =
      results.lines.length > 0 ? results.lines.join("\n") : "No matches found.";
    if (notices.length > 0) {
      output += `\n\n${notices.map((notice) => `(${notice})`).join("\n")}`;
    }
    return { output, isError: false };
  }
}
