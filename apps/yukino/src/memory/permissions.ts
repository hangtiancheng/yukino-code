import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";

import { PermissionChecker, type Decision } from "@/permissions/index.js";
import type { ToolCategory } from "@/tools/types.js";
import { canonicalPath, isPathWithin } from "@/utils/paths.js";

export class MemoryPermissionChecker extends PermissionChecker {
  private memoryRoots: string[];

  constructor(
    private memoryWorkDir: string,
    private allowProjectReads = false,
  ) {
    super(memoryWorkDir, "default");
    this.memoryRoots = [
      join(memoryWorkDir, ".yukino", "memory"),
      join(homedir(), ".yukino", "memory"),
    ];
  }

  override check(
    _name: string,
    category: ToolCategory,
    args: Record<string, unknown>,
  ): Decision {
    const requested = args.file_path ?? args.path ?? this.memoryWorkDir;
    if (category === "command" || typeof requested !== "string") {
      return {
        effect: "deny",
        reason: "Background memory tasks only support scoped file operations",
      };
    }
    const path = canonicalPath(resolve(this.memoryWorkDir, requested));
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
        isPathWithin(canonicalPath(this.memoryWorkDir), path))
      ? { effect: "allow", reason: "Memory task read" }
      : { effect: "deny", reason: "Read outside the memory task's scope" };
  }
}
