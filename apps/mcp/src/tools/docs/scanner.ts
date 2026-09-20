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

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { logger } from "../../shared/logger.js";

const SUPPORTED_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);

export interface ScannedDoc {
  /** Path relative to the docs dir, POSIX-separated — used as the _source tag. */
  source: string;
  content: string;
}

/**
 * Recursively scan a knowledge-base directory for supported documents.
 * A missing directory is a normal state (user has no knowledge base yet)
 * and yields an empty list; unreadable files are skipped with a warning.
 */
export async function scanDocsDir(dir: string): Promise<ScannedDoc[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true });
  } catch {
    return [];
  }

  const docs: ScannedDoc[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      continue;
    }
    const absolute = path.join(entry.parentPath, entry.name);
    const source = path.relative(dir, absolute).split(path.sep).join("/");
    try {
      docs.push({ source, content: await readFile(absolute, "utf-8") });
    } catch (err) {
      logger.warn({ err, source }, "failed to read document, skipping");
    }
  }
  docs.sort((a, b) => a.source.localeCompare(b.source));
  return docs;
}
