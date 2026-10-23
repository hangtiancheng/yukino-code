import { statSync } from "fs";
import { resolve } from "path";

import { createChildLogger } from "@yukino.js/logger";
import {
  FILE_DELETED_ERROR,
  FILE_MODIFIED_ERROR,
  FILE_NOT_READ_ERROR,
} from "./constants.js";
import { canonicalPath } from "@yukino.js/utils/paths.js";

const log = createChildLogger({ module: "file-state-cache" });

export class FileStateCache {
  private cache = new Map<string, number>(); // canonical path -> mtimeMs

  // All lookups share one canonical key so symlink aliases and platform path
  // aliases (e.g. macOS /tmp -> /private/tmp) never record under one name and
  // check under another. Canonicalization failures fall back to the resolved
  // absolute path so deleted/inaccessible files still get a stable key.
  private key(filePath: string): string {
    try {
      return canonicalPath(filePath);
    } catch {
      return resolve(filePath);
    }
  }

  /** Called after a successful ReadFile to register the file as "seen". */
  record(filePath: string, lastModifiedTimeMs: number) {
    this.cache.set(this.key(filePath), lastModifiedTimeMs);
  }

  has(filePath: string): boolean {
    return this.cache.has(this.key(filePath));
  }

  /**
   * Gate check before EditFile / WriteFile
   */
  check(filePath: string): { ok: true } | { ok: false; error: string } {
    const key = this.key(filePath);
    const mtimeMs = this.cache.get(key);
    if (mtimeMs === undefined) {
      return {
        ok: false,
        error: FILE_NOT_READ_ERROR,
      };
    }

    let currentModifiedTime: number;
    try {
      currentModifiedTime = statSync(key).mtimeMs;
    } catch (err) {
      log.error({ err }, "file state cache operation failed");
      return {
        ok: false,
        error: FILE_DELETED_ERROR,
      };
    }

    if (currentModifiedTime !== mtimeMs) {
      return {
        ok: false,
        error: FILE_MODIFIED_ERROR,
      };
    }
    return { ok: true };
  }

  /**
   * Called after a successful edit / write to keep the cache in sync
   * with the new on-disk state
   */
  update(filePath: string): void {
    const key = this.key(filePath);
    let lastModifiedTimeMs: number;
    try {
      lastModifiedTimeMs = statSync(key).mtimeMs;
    } catch (err) {
      // If we can't stat (shouldn't happen right after a write),
      // just remove the entry so next edit requires a fresh read
      log.error({ err }, "file state cache operation failed");
      this.cache.delete(key);

      return;
    }

    this.cache.set(key, lastModifiedTimeMs);
  }

  delete(filePath: string): void {
    this.cache.delete(this.key(filePath));
  }

  clear(): void {
    this.cache.clear();
  }
}
