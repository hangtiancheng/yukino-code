import { extname, resolve } from "node:path";

import { PermissionChecker, type Decision } from "@/permissions/index.js";
import { projectPath, yukinoPath } from "@/storage/paths.js";
import type { ToolCategory } from "@/tools/types.js";
import { canonicalPath, isPathWithin } from "@/utils/paths.js";

export class MemoryPermissionChecker extends PermissionChecker {
  private memoryRoots: string[];

  constructor(
    private memoryCwd: string,
    private allowProjectReads = false,
  ) {
    super(memoryCwd, "default");
    this.memoryRoots = [projectPath(memoryCwd, "memory"), yukinoPath("memory")];
  }

  override check(
    _name: string,
    category: ToolCategory,
    args: Record<string, unknown>,
  ): Decision {
    const requested = args.file_path ?? args.path ?? this.memoryCwd;
    if (category === "command" || typeof requested !== "string") {
      return {
        effect: "deny",
        reason: "Background memory tasks only support scoped file operations",
      };
    }
    const path = canonicalPath(resolve(this.memoryCwd, requested));
    const insideMemory = this.memoryRoots.some((root) =>
      isPathWithin(canonicalPath(root), path),
    );
    if (category === "write") {
      return insideMemory && extname(path) === ".md"
        ? { effect: "allow", reason: "Memory file update" }
        : {
            effect: "deny",
            reason:
              "Background memory writes must stay in the memory directories and use .md files",
          };
    }
    return insideMemory ||
      (this.allowProjectReads &&
        isPathWithin(canonicalPath(this.memoryCwd), path))
      ? { effect: "allow", reason: "Memory task read" }
      : { effect: "deny", reason: "Read outside the memory task's scope" };
  }
}
