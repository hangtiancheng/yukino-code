import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { logger } from "@/shared/logger.js";

const SUPPORTED_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);

export interface ScannedDoc {
  /** Path relative to the docs dir, POSIX-separated — used as the _source tag. */
  source: string;
  content: string | null;
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
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT")
      return [];
    throw err;
  }

  const docs: ScannedDoc[] = [];
  for (const entry of entries) {
    if (
      !entry.isFile() ||
      !SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
    ) {
      continue;
    }
    const absolute = path.join(entry.parentPath, entry.name);
    const source = path.relative(dir, absolute).split(path.sep).join("/");
    try {
      docs.push({ source, content: await readFile(absolute, "utf-8") });
    } catch (err) {
      docs.push({ source, content: null });
      logger.warn(
        { err, source },
        "failed to read document, preserving existing index",
      );
    }
  }
  docs.sort((a, b) => a.source.localeCompare(b.source));
  return docs;
}
