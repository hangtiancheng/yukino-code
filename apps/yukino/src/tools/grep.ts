import type { Dir, Stats } from "node:fs";
import { lstat, open, opendir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { Worker } from "node:worker_threads";

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
import {
  isPrivateStatePath,
  protectPrivateFileSync,
} from "@/storage/private.js";
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

// A catastrophic-backtracking pattern can pin RegExp.prototype.test on a single
// line essentially forever. The per-line matching therefore runs in a worker
// thread: the main loop (UI heartbeat, cancel handling) stays responsive, and a
// hard per-file budget can terminate the worker instead of hanging.
const REGEX_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('worker_threads');
const regex = new RegExp(workerData.pattern, workerData.flags);
parentPort.on('message', (msg) => {
  const matches = [];
  let start = 0;
  for (let index = 0; start <= msg.text.length; index++) {
    const end = msg.text.indexOf('\n', start);
    const line = msg.text.slice(start, end < 0 ? undefined : end);
    if (regex.test(line)) {
      matches.push({ index, line });
      if (matches.length >= workerData.maxMatches) break;
    }
    if (end < 0) break;
    start = end + 1;
  }
  parentPort.postMessage({ id: msg.id, matches });
});
parentPort.postMessage({ ready: true });
`;

interface RegexMatch {
  index: number;
  line: string;
}

const MATCH_MIN_TIMEOUT_MS = 2000;
const MATCH_MAX_TIMEOUT_MS = 10000;

export class GrepPatternTooSlowError extends Error {
  constructor() {
    super(
      "Error: the pattern timed out while matching (likely catastrophic backtracking). Simplify it — avoid nested quantifiers such as (a+)+ — or narrow the path/include filter.",
    );
    this.name = "GrepPatternTooSlowError";
  }
}

class RegexMatchWorker {
  private worker: Worker;
  private ready: Promise<void>;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: RegexMatch[]) => void; reject: (e: unknown) => void }
  >();
  private terminated = false;

  constructor(pattern: string, flags: string) {
    this.worker = new Worker(REGEX_WORKER_SOURCE, {
      eval: true,
      workerData: { pattern, flags, maxMatches: MAX_RESULTS + 1 },
    });
    this.ready = new Promise<void>((resolve, reject) => {
      const onReady = (msg: { ready?: boolean }) => {
        if (msg.ready) {
          this.worker.off("message", onReady);
          resolve();
        }
      };
      this.worker.on("message", onReady);
      this.worker.once("error", reject);
    });
    void this.ready.catch(() => undefined);
    this.worker.on(
      "message",
      (msg: { id?: number; matches?: RegexMatch[] }) => {
        if (typeof msg.id !== "number") {
          return;
        }
        const waiter = this.pending.get(msg.id);
        if (waiter) {
          this.pending.delete(msg.id);
          waiter.resolve(msg.matches ?? []);
        }
      },
    );
    this.worker.on("error", (err) => {
      for (const waiter of this.pending.values()) {
        waiter.reject(err);
      }
      this.pending.clear();
    });
  }

  match(
    text: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<RegexMatch[]> {
    if (signal?.aborted) {
      return Promise.reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("operation interrupted"),
      );
    }
    if (this.terminated) {
      return Promise.reject(new Error("regex matcher is terminated"));
    }
    const id = this.nextId++;
    return new Promise<RegexMatch[]>((resolve, reject) => {
      const state: { timer?: NodeJS.Timeout } = {};
      const cleanup = () => {
        if (state.timer) {
          clearTimeout(state.timer);
        }
        signal?.removeEventListener("abort", onAbort);
      };
      const fail = (err: unknown) => {
        cleanup();
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      const onAbort = () => {
        this.pending.delete(id);
        void this.terminate();
        fail(signal?.reason ?? new Error("operation interrupted"));
      };
      state.timer = setTimeout(() => {
        this.pending.delete(id);
        void this.terminate();
        fail(new GrepPatternTooSlowError());
      }, timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (v) => {
          cleanup();
          resolve(v);
        },
        reject: fail,
      });
      this.ready
        .then(() => {
          if (!this.terminated) {
            this.worker.postMessage({ id, text });
          }
        })
        .catch(fail);
    });
  }

  async terminate(): Promise<void> {
    if (this.terminated) {
      return;
    }
    this.terminated = true;
    for (const waiter of this.pending.values()) {
      waiter.reject(new Error("operation interrupted"));
    }
    this.pending.clear();
    await this.worker.terminate();
  }
}

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
    // One worker per Grep call, reused across every file; matching is off the
    // main thread so the UI heartbeat and cancel stay live even on a huge tree.
    const matcher = new RegexMatchWorker(regex.source, regex.flags);

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
      if (ctx.permissionChecker?.canReadSearchPath(filePath) === false) {
        return;
      }
      try {
        const fileStat = knownStat ?? (await stat(filePath));
        if (fileStat.size > MAX_GREP_FILE_BYTES) {
          skippedLargeFiles++;
          return;
        }

        if (isPrivateStatePath(filePath)) {
          protectPrivateFileSync(filePath);
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
          const text = buf.toString("utf-8");
          const rel = relative(ctx.cwd, filePath);

          // Matching runs off the main thread under a size-scaled budget so a
          // catastrophic pattern is terminated instead of pinning the loop.
          const matchTimeout = Math.min(
            MATCH_MAX_TIMEOUT_MS,
            Math.max(MATCH_MIN_TIMEOUT_MS, Math.ceil(fileStat.size / 1024) * 5),
          );
          const matched = await matcher.match(
            text,
            matchTimeout,
            ctx.abortSignal,
          );
          for (const { index: i, line } of matched) {
            const preview = takeUtf8Prefix(line, MAX_MATCH_LINE_BYTES);
            const shortened = preview.length < line.length;
            if (
              !results.append(
                `${rel}:${String(i + 1)}:${preview}${shortened ? "…" : ""}`,
              )
            ) {
              break;
            }
            shortenedLines += Number(shortened);
          }
        } finally {
          await file.close();
        }
      } catch (err) {
        if (err instanceof GrepPatternTooSlowError) {
          throw err;
        }
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
          if (ctx.permissionChecker?.canReadSearchPath(fullPath) === false) {
            continue;
          }
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
        if (err instanceof GrepPatternTooSlowError) {
          throw err;
        }
        ctx.abortSignal?.throwIfAborted();
        log.error({ err }, "tool operation failed");
      }
    };

    let searchError: ToolResult | undefined;
    try {
      const pathStat = await stat(searchPath);
      if (pathStat.isFile()) {
        await searchFile(searchPath, pathStat);
      } else {
        await walk(searchPath, 0);
      }
      ctx.abortSignal?.throwIfAborted();
    } catch (err) {
      if (err instanceof GrepPatternTooSlowError) {
        searchError = { output: err.message, isError: true };
      } else {
        log.error({ err }, "tool operation failed");
        searchError = {
          output: ctx.abortSignal?.aborted
            ? "Error: operation interrupted"
            : `Error: ${asErrorString(err)}`,
          isError: true,
        };
      }
    } finally {
      await matcher.terminate();
    }
    if (searchError) {
      return searchError;
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
