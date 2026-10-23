import { statSync } from "fs";
import { dirname, relative, sep } from "path";

import { createChildLogger } from "@yukino.js/logger";
import { asErrorString, strArg } from "@yukino.js/utils";
import { resolveToolPath } from "@yukino.js/utils/paths.js";
import { globIterate } from "glob";

import {
  OPERATION_INTERRUPTED_ERROR,
  PATTERN_REQUIRED_ERROR,
  SKIP_DIRS,
} from "./constants.js";
import {
  GLOB_DESCRIPTION,
  GLOB_PATH_DESCRIPTION,
  GLOB_PATTERN_DESCRIPTION,
} from "./prompts.js";
import { SearchOutput } from "./search-output.js";
import {
  type Tool,
  type ToolCategory,
  type ToolContext,
  type ToolResult,
  type ToolSchema,
} from "./types.js";

const log = createChildLogger({ module: "tools" });

export class GlobTool implements Tool {
  // Use a hardcoded string instead of GlobTool.name.replace("Tool", "")
  // because class names are not stable after minification — bundlers like
  // Terser/esbuild may rename or mangle them, producing incorrect tool names at runtime.
  name = "Glob";
  description = GLOB_DESCRIPTION;
  category: ToolCategory = "read";

  schema(): ToolSchema {
    const inputSchema = {
      type: "object" as const,
      properties: {
        pattern: {
          type: "string" as const,
          description: GLOB_PATTERN_DESCRIPTION,
        },
        path: {
          type: "string" as const,
          description: GLOB_PATH_DESCRIPTION,
          default: ".",
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
      return { output: OPERATION_INTERRUPTED_ERROR, isError: true };
    }
    const rawPattern = strArg(args, "pattern");
    const pattern = rawPattern.startsWith("~/")
      ? resolveToolPath(ctx.cwd, rawPattern)
      : rawPattern;
    if (!pattern) {
      return {
        output: PATTERN_REQUIRED_ERROR,
        isError: true,
      };
    }

    const basePath = resolveToolPath(ctx.cwd, strArg(args, "path", ctx.cwd));
    const maxResults = 1000;
    try {
      if (!statSync(basePath, { throwIfNoEntry: false })?.isDirectory()) {
        return {
          output: `Error: not a directory, scan '${basePath}'`,
          isError: true,
        };
      }
      const results = new SearchOutput(maxResults);
      const absolutePattern = resolveToolPath(basePath, pattern);
      const magic = absolutePattern.search(/[*?{[(]/u);
      const scanRoot = dirname(
        magic < 0 ? absolutePattern : `${absolutePattern.slice(0, magic)}_`,
      );
      const ignored = (path: string): boolean => {
        const segments = relative(scanRoot, path).split(sep);
        return (
          segments[0] !== ".." &&
          segments.some((segment) => SKIP_DIRS.has(segment))
        );
      };
      // matchBase: patterns without "/" match the basename at any depth,
      // patterns with "/" match the cwd-relative path. `follow` stays false,
      // so symlinked directories are never descended (cycle-safe).
      for await (const match of globIterate(pattern, {
        cwd: basePath,
        ignore: {
          ignored: (entry) =>
            ignored(entry.fullpath()) ||
            (entry.fullpath() !== basePath &&
              ctx.permissionChecker?.canTraverseSearchPath(entry.fullpath()) ===
                false),
          childrenIgnored: (entry) =>
            ignored(entry.fullpath()) ||
            (entry.fullpath() !== basePath &&
              ctx.permissionChecker?.canTraverseSearchPath(entry.fullpath()) ===
                false),
        },
        // Agents need hidden-but-tracked paths (.github/workflows, .eslintrc…);
        // SKIP_DIRS already prunes noisy dot dirs like .git.
        dot: true,
        matchBase: true,
        nodir: true,
        signal: ctx.abortSignal,
      })) {
        ctx.abortSignal?.throwIfAborted();
        if (
          ctx.permissionChecker?.canReadSearchPath(
            resolveToolPath(basePath, match),
          ) === false
        ) {
          continue;
        }
        if (!results.append(match)) {
          break;
        }
      }
      ctx.abortSignal?.throwIfAborted();
      const matches = results.lines;

      if (matches.length === 0) {
        return {
          output: "No files matched the pattern.",
          isError: false,
        };
      }

      const mtimes = new Map<string, number>();
      for (const match of matches) {
        let mtime = 0;
        try {
          mtime = statSync(resolveToolPath(basePath, match)).mtimeMs;
        } catch {
          // stat failed: sort as oldest (mtime 0)
        }
        mtimes.set(match, mtime);
      }
      matches.sort(
        (a, b) =>
          (mtimes.get(b) ?? 0) - (mtimes.get(a) ?? 0) || a.localeCompare(b),
      );

      let output = matches.join("\n");
      if (results.limit === "matches") {
        output += `\n(Results limited to ${String(maxResults)} files. Use a more specific pattern.)`;
      } else if (results.limit === "bytes") {
        output +=
          "\n(Results limited to 50KB. Use a more specific pattern or path.)";
      }

      return {
        output,
        isError: false,
      };
    } catch (err) {
      log.error({ err }, "tool operation failed");
      return {
        output: ctx.abortSignal?.aborted
          ? OPERATION_INTERRUPTED_ERROR
          : `Error: ${asErrorString(err)}`,
        isError: true,
      };
    }
  }
}
