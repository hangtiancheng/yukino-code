import { stat } from "node:fs/promises";
import { relative, sep } from "node:path";
import { createInterface } from "node:readline";

import { rgPath } from "@vscode/ripgrep";
import { execa } from "execa";
import type { Path as GlobPath } from "glob";
import { globIterate } from "glob";
import { Minimatch } from "minimatch";
import { z } from "zod";

import { createChildLogger } from "@/logger/index.js";
import {
  isPrivateStatePath,
  protectPrivateFileSync,
} from "@/storage/private.js";
import {
  DEFAULT_MAX_TRAVERSED_ENTRIES,
  DEFAULT_MAX_TRAVERSAL_DEPTH,
  GREP_BATCH_MAX_FILES,
  GREP_BATCH_MAX_PATH_BYTES,
  GREP_STDERR_MAX_BYTES,
  GREP_TIMEOUT_MS,
  GREP_TIMEOUT_ERROR,
  MAX_GREP_FILE_BYTES,
  MAX_MATCH_LINE_BYTES,
  MAX_RESULTS,
  OPERATION_INTERRUPTED_ERROR,
  PATTERN_REQUIRED_ERROR,
  SKIP_DIRS,
} from "@/tools/constants.js";
import {
  GREP_DESCRIPTION,
  GREP_INCLUDE_DESCRIPTION,
  GREP_PATH_DESCRIPTION,
  GREP_PATTERN_DESCRIPTION,
} from "@/tools/prompts.js";
import { SearchOutput } from "@/tools/search-output.js";
import { takeUtf8Prefix } from "@/tools/shell-output.js";
import type { ToolCategory, ToolContext, ToolResult } from "@/tools/types.js";
import { ValidatedTool } from "@/tools/validated-tool.js";
import { asErrorString } from "@/utils/index.js";
import { resolveToolPath } from "@/utils/paths.js";

const log = createChildLogger({ module: "tools" });
const RipgrepTextSchema = z.union([
  z.object({ text: z.string() }).transform(({ text }) => text),
  z
    .object({ bytes: z.string() })
    .transform(({ bytes }) => Buffer.from(bytes, "base64").toString("utf8")),
]);
const RipgrepMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("match"),
    data: z.object({
      path: RipgrepTextSchema,
      lines: RipgrepTextSchema,
      line_number: z.number().int().positive(),
    }),
  }),
  z.object({
    type: z.literal("end"),
    data: z.object({ binary_offset: z.number().nullable() }),
  }),
]);

export interface GrepTraversalLimits {
  maxEntries: number;
  maxDepth: number;
}

const GrepToolInputSchema = z.strictObject({
  pattern: z.string().describe(GREP_PATTERN_DESCRIPTION),
  path: z.string().describe(GREP_PATH_DESCRIPTION).default("."),
  include: z.string().describe(GREP_INCLUDE_DESCRIPTION).optional(),
});

export class GrepTool extends ValidatedTool<
  z.output<typeof GrepToolInputSchema>
> {
  name = "Grep";
  description = GREP_DESCRIPTION;
  category: ToolCategory = "read";

  constructor(
    private readonly traversalLimits: GrepTraversalLimits = {
      maxEntries: DEFAULT_MAX_TRAVERSED_ENTRIES,
      maxDepth: DEFAULT_MAX_TRAVERSAL_DEPTH,
    },
  ) {
    super();
  }

  parameters() {
    return GrepToolInputSchema;
  }

  protected async executeValidated(
    ctx: ToolContext,
    args: z.output<typeof GrepToolInputSchema>,
  ): Promise<ToolResult> {
    if (ctx.abortSignal?.aborted) {
      return { output: OPERATION_INTERRUPTED_ERROR, isError: true };
    }
    const pattern = args.pattern ?? "";
    if (!pattern) {
      return { output: PATTERN_REQUIRED_ERROR, isError: true };
    }
    const searchPath = resolveToolPath(ctx.cwd, args.path ?? ctx.cwd);
    const include = args.include ?? "";
    const includeMatcher = include
      ? new Minimatch(include, { dot: true, matchBase: true })
      : null;
    const results = new SearchOutput(MAX_RESULTS);
    let shortenedLines = 0;
    let skippedLargeFiles = 0;
    let entryLimitReached = false;
    let depthLimitReached = false;

    const searchBatch = async (
      paths: string[],
      validate = false,
    ): Promise<void> => {
      ctx.abortSignal?.throwIfAborted();
      const files = paths.filter(
        (path) => ctx.permissionChecker?.canReadSearchPath(path) !== false,
      );
      if (!files.length && !validate) {
        return;
      }
      for (const file of files) {
        if (isPrivateStatePath(file)) {
          protectPrivateFileSync(file);
        }
      }
      const execution = execa(
        rgPath,
        [
          "--no-config",
          "--json",
          "--ignore-case",
          "--no-mmap",
          "--no-ignore",
          "--hidden",
          "--threads=1",
          "--max-depth=0",
          `--max-filesize=${String(MAX_GREP_FILE_BYTES)}`,
          `--max-count=${String(MAX_RESULTS + 1)}`,
          "--regexp",
          pattern,
          "--",
          ...(validate ? ["-"] : files),
        ],
        {
          cwd: ctx.cwd,
          stdin: "ignore",
          buffer: false,
          reject: false,
          timeout: GREP_TIMEOUT_MS,
          cancelSignal: ctx.abortSignal,
          killDescendants: true,
        },
      );
      const child = execution.nodeChildProcess;
      let failure: Error | undefined;
      let stderr = "";
      let timedOut = false;
      const completion = execution.then((result) => {
        timedOut = result.timedOut;
        if (
          result.failed &&
          result.exitCode === undefined &&
          !result.isCanceled &&
          !result.isTerminated
        ) {
          failure = new Error(result.message);
        }
        return result.exitCode ?? null;
      });
      if (!child.stdout || !child.stderr) {
        throw new Error("ripgrep output pipes are unavailable");
      }
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = takeUtf8Prefix(
          stderr + chunk.toString("utf8"),
          GREP_STDERR_MAX_BYTES,
        );
      });
      const reader = createInterface({
        input: child.stdout,
        crlfDelay: Infinity,
      });
      let pending: { text: string; shortened: boolean }[] = [];
      try {
        for await (const line of reader) {
          const raw: unknown = JSON.parse(line);
          const parsed = RipgrepMessageSchema.safeParse(raw);
          if (!parsed.success) {
            continue;
          }
          const message = parsed.data;
          if (message.type === "match") {
            const content = message.data.lines.replace(/\r?\n$/u, "");
            const preview = takeUtf8Prefix(content, MAX_MATCH_LINE_BYTES);
            const shortened = preview.length < content.length;
            pending.push({
              text: `${relative(ctx.cwd, message.data.path)}:${String(message.data.line_number)}:${preview}${shortened ? "…" : ""}`,
              shortened,
            });
          } else {
            // ripgrep may emit matches before discovering a NUL byte in the same file.
            if (message.data.binary_offset === null) {
              for (const entry of pending) {
                if (!results.append(entry.text)) {
                  break;
                }
                shortenedLines += Number(entry.shortened);
              }
            }
            pending = [];
            if (results.limit) {
              execution.kill();
              break;
            }
          }
        }
        await completion;
      } finally {
        reader.close();
        execution.kill();
        await completion;
      }
      ctx.abortSignal?.throwIfAborted();
      if (failure) {
        throw failure;
      }
      if (timedOut) {
        throw new Error(GREP_TIMEOUT_ERROR);
      }
      if (!results.limit && child.exitCode !== 0 && child.exitCode !== 1) {
        throw new Error(stderr.trim() || "ripgrep search failed");
      }
    };

    try {
      await searchBatch([], true);
      const root = await stat(searchPath);
      let batch: string[] = [];
      let pathBytes = 0;
      const addFile = async (path: string) => {
        if (ctx.permissionChecker?.canReadSearchPath(path) === false) {
          return;
        }
        const info = await stat(path);
        if (!info.isFile()) {
          return;
        }
        if (info.size > MAX_GREP_FILE_BYTES) {
          skippedLargeFiles++;
          return;
        }
        const bytes = Buffer.byteLength(path);
        if (
          batch.length &&
          (batch.length >= GREP_BATCH_MAX_FILES ||
            pathBytes + bytes > GREP_BATCH_MAX_PATH_BYTES)
        ) {
          await searchBatch(batch);
          batch = [];
          pathBytes = 0;
        }
        if (!results.limit) {
          batch.push(path);
          pathBytes += bytes;
        }
      };
      if (root.isFile()) {
        await addFile(searchPath);
      } else if (root.isDirectory()) {
        const visited = new Set<string>();
        const ignored = (entry: GlobPath): boolean => {
          const path = entry.fullpath();
          if (path !== searchPath && !visited.has(path)) {
            if (visited.size >= this.traversalLimits.maxEntries) {
              entryLimitReached = true;
              return true;
            }
            visited.add(path);
          }
          if (path !== searchPath && SKIP_DIRS.has(entry.name)) {
            return true;
          }
          if (entry.isDirectory()) {
            const depth = relative(searchPath, path)
              .split(sep)
              .filter(Boolean).length;
            if (depth > this.traversalLimits.maxDepth) {
              depthLimitReached = true;
              return true;
            }
            return ctx.permissionChecker?.canTraverseSearchPath(path) === false;
          }
          return ctx.permissionChecker?.canReadSearchPath(path) === false;
        };
        for await (const entry of globIterate("**/*", {
          cwd: searchPath,
          dot: true,
          nodir: true,
          follow: false,
          stat: true,
          withFileTypes: true,
          signal: ctx.abortSignal,
          ignore: {
            ignored,
            childrenIgnored: (entry) =>
              entry.isSymbolicLink() || ignored(entry),
          },
        })) {
          ctx.abortSignal?.throwIfAborted();
          if (results.limit) {
            break;
          }
          const path = entry.fullpath();
          if (
            includeMatcher &&
            !includeMatcher.match(relative(ctx.cwd, path).split(sep).join("/"))
          ) {
            continue;
          }
          try {
            await addFile(path);
          } catch (error) {
            ctx.abortSignal?.throwIfAborted();
            // Vanishing or unreadable files do not hide the rest of the search.
            if (
              error instanceof Error &&
              "code" in error &&
              ["ENOENT", "EACCES", "EPERM"].includes(String(error.code))
            ) {
              continue;
            }
            throw error;
          }
        }
      }
      if (!results.limit) {
        await searchBatch(batch);
      }
      ctx.abortSignal?.throwIfAborted();
    } catch (error) {
      log.error({ err: error }, "ripgrep search failed");
      return {
        output: ctx.abortSignal?.aborted
          ? OPERATION_INTERRUPTED_ERROR
          : `Error: ${asErrorString(error)}`,
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
    const output = results.lines.length
      ? results.lines.join("\n")
      : "No matches found.";
    return {
      output:
        output +
        (notices.length
          ? `\n\n${notices.map((notice) => `(${notice})`).join("\n")}`
          : ""),
      isError: false,
    };
  }
}
