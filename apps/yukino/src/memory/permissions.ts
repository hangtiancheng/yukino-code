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
