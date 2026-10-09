import { statSync } from "fs";
import { join } from "path";

import { globIterate } from "glob";

import { GLOB_DESCRIPTION } from "./descriptions.js";
import { SearchOutput } from "./search-output.js";
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

// glob's `ignore` patterns are matched against cwd-relative paths, so each
// skipped directory needs the `**/<name>/**` form to be pruned at any depth.
const IGNORE = [...SKIP_DIRS].map((dir) => `**/${dir}/**`);

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
          description:
            "Filename glob relative to path, e.g. '**/*.ts' for recursive search or '*.{ts,tsx}' for direct children.",
        },
        path: {
          type: "string" as const,
          description:
            "Search base, absolute or relative to the Agent's working directory (default '.'). Returned filenames are relative to this base.",
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
      return { output: "Error: operation interrupted", isError: true };
    }
    const pattern = strArg(args, "pattern");
    if (!pattern) {
      return {
        output: "Error: pattern is required",
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
      // matchBase: patterns without "/" match the basename at any depth,
      // patterns with "/" match the cwd-relative path. `follow` stays false,
      // so symlinked directories are never descended (cycle-safe).
      for await (const match of globIterate(pattern, {
        cwd: basePath,
        ignore: IGNORE,
        // Agents need hidden-but-tracked paths (.github/workflows, .eslintrc…);
        // SKIP_DIRS already prunes noisy dot dirs like .git.
        dot: true,
        matchBase: true,
        nodir: true,
        signal: ctx.abortSignal,
      })) {
        ctx.abortSignal?.throwIfAborted();
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
          mtime = statSync(join(basePath, match)).mtimeMs;
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
          ? "Error: operation interrupted"
          : `Error: ${asErrorString(err)}`,
        isError: true,
      };
    }
  }
}
