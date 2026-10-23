import { extname } from "node:path";

import { PermissionChecker, type Decision } from "@yukino.js/permissions";
import { projectPath, yukinoPath, getSessionsDir } from "@yukino.js/storage";
import type { ToolCategory } from "@yukino.js/tools/types.js";
import { asErrorString, strArg } from "@yukino.js/utils";
import {
  canonicalPath,
  isPathWithin,
  resolveToolPath,
} from "@yukino.js/utils/paths.js";

import {
  GLOB_ESCAPE_RE,
  GLOB_MAGIC_RE,
  MEMORY_DIR_NAME,
  MEMORY_TASK_TOOLS,
} from "./constants.js";

export class MemoryPermissionChecker extends PermissionChecker {
  private memoryRoots: string[];
  private readRoots: string[];

  constructor(
    private memoryCwd: string,
    allowProjectReads = false,
  ) {
    super(memoryCwd, "default");
    this.memoryRoots = [
      projectPath(memoryCwd, MEMORY_DIR_NAME),
      yukinoPath(MEMORY_DIR_NAME),
    ];
    this.readRoots = [
      ...this.memoryRoots,
      ...(allowProjectReads ? [memoryCwd, getSessionsDir(memoryCwd)] : []),
    ];
  }

  override canReadSearchPath(path: string): boolean {
    try {
      const target = canonicalPath(resolveToolPath(this.memoryCwd, path));
      return this.readRoots.some((root) =>
        isPathWithin(canonicalPath(root), target),
      );
    } catch {
      return false;
    }
  }

  override canTraverseSearchPath(path: string): boolean {
    try {
      const absolute = resolveToolPath(this.memoryCwd, path);
      const target = canonicalPath(absolute);
      return this.readRoots.some((root) => {
        const canonical = canonicalPath(root);
        return (
          isPathWithin(canonical, target) ||
          (isPathWithin(absolute, resolveToolPath(this.memoryCwd, root)) &&
            isPathWithin(target, canonical))
        );
      });
    } catch {
      return false;
    }
  }

  override check(
    name: string,
    category: ToolCategory,
    args: Record<string, unknown>,
  ): Decision {
    try {
      const explicit = this.checkExplicitRules(name, args);
      if (explicit && explicit.effect !== "allow") {
        return {
          effect: "deny",
          reason: `Background memory cannot approve: ${explicit.reason}`,
        };
      }
      if (!MEMORY_TASK_TOOLS.has(name) || category === "command") {
        return {
          effect: "deny",
          reason: "Background memory tasks only support scoped file operations",
        };
      }
      const requested =
        name === "Glob" || name === "Grep"
          ? (args.path ?? this.memoryCwd)
          : args.file_path;
      if (typeof requested !== "string") {
        return { effect: "deny", reason: "Invalid memory task path" };
      }
      const path = canonicalPath(resolveToolPath(this.memoryCwd, requested));
      if (category === "write") {
        const insideMemory = this.memoryRoots.some((root) =>
          isPathWithin(canonicalPath(root), path),
        );
        return insideMemory && extname(path) === ".md"
          ? { effect: "allow", reason: "Memory file update" }
          : {
              effect: "deny",
              reason:
                "Background memory writes must stay in the memory directories and use .md files",
            };
      }
      if (name === "Glob") {
        const pattern = strArg(args, "pattern");
        if (!pattern || GLOB_ESCAPE_RE.test(pattern)) {
          return {
            effect: "deny",
            reason: "Glob pattern escapes the memory task scope",
          };
        }
        const absolute = resolveToolPath(path, pattern);
        const magic = absolute.search(GLOB_MAGIC_RE);
        const prefix =
          magic < 0
            ? absolute
            : absolute.slice(0, absolute.lastIndexOf("/", magic) + 1);
        if (!this.canReadSearchPath(prefix)) {
          return {
            effect: "deny",
            reason: "Glob pattern escapes the memory task scope",
          };
        }
      } else if (!this.canReadSearchPath(path)) {
        return {
          effect: "deny",
          reason: "Read outside the memory task's scope",
        };
      }
      return { effect: "allow", reason: "Memory task read" };
    } catch (error) {
      return {
        effect: "deny",
        reason: `Memory path resolution failed: ${asErrorString(error)}`,
      };
    }
  }
}
