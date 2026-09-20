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

import { statSync } from "fs";

import { createChildLogger } from "@/logger/index.js";

const log = createChildLogger({ module: "file-state-cache" });

export class FileStateCache {
  private cache = new Map<string, number>(); // path -> mtimeMs

  /** Called after a successful ReadFile to register the file as "seen". */
  record(filePath: string, lastModifiedTimeMs: number) {
    this.cache.set(filePath, lastModifiedTimeMs);
  }

  has(filePath: string): boolean {
    return this.cache.has(filePath);
  }

  /**
   * Gate check before EditFile / WriteFile
   */
  check(filePath: string): { ok: true } | { ok: false; error: string } {
    const mtimeMs = this.cache.get(filePath);
    if (mtimeMs === undefined) {
      return {
        ok: false,
        error:
          "Error: file has not been read yet, read it first before editing.",
      };
    }

    let currentModifiedTime: number;
    try {
      /** mtimeMs: modification time in milliseconds */
      currentModifiedTime = statSync(filePath).mtimeMs;
    } catch (err) {
      log.error({ err }, "file state cache operation failed");
      return {
        ok: false,
        error:
          "Error: file was deleted or is no longer accessible; read it again before editing.",
      };
    }

    if (currentModifiedTime !== mtimeMs) {
      return {
        ok: false,
        error:
          "Error: file has been modified since last read, read it again before editing.",
      };
    }
    return { ok: true };
  }

  /**
   * Called after a successful edit / write to keep the cache in sync
   * with the new on-disk state
   */
  update(filePath: string): void {
    let lastModifiedTimeMs: number;
    try {
      lastModifiedTimeMs = statSync(filePath).mtimeMs;
    } catch (err) {
      // If we can't stat (shouldn't happen right after a write),
      // just remove the entry so next edit requires a fresh read
      log.error({ err }, "file state cache operation failed");
      this.cache.delete(filePath);

      return;
    }

    this.cache.set(filePath, lastModifiedTimeMs);
  }
}
