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

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { isImagePath, MAX_IMAGES_PER_MESSAGE, loadImageAttachment } from "@/images/index.js";
import { createChildLogger } from "@/logger/index.js";

const log = createChildLogger({ module: "terminal" });
const MAX_INLINE_BYTES = 100_000;
// Files larger than this are never read, even for a narrow line range.
const MAX_RANGE_FILE_BYTES = 10_000_000;

// An @ref may carry a #L3 or #L3-10 suffix (inserted via the IDE integration).
function parseRef(ref: string): {
  path: string;
  lineStart?: number;
  lineEnd?: number;
} {
  const m = /^(.+)#L(\d+)(?:-(\d+))?$/.exec(ref);
  if (!m) {
    return { path: ref };
  }
  const lineStart = Number.parseInt(m[2], 10);
  return {
    path: m[1],
    lineStart,
    lineEnd: m[3] ? Number.parseInt(m[3], 10) : lineStart,
  };
}

function sliceLines(content: string, lineStart: number, lineEnd: number): string {
  const all = content.split("\n");
  const from = Math.max(1, lineStart);
  const to = Math.min(all.length, Math.max(lineEnd, from));
  return all.slice(from - 1, to).join("\n");
}

function collectAtRefs(text: string): string[] {
  // Clipboard images and paths containing spaces use quoted mentions.
  const pattern = /(?:^|\s)(?:'@([^']+)'|"@([^"]+)"|@"([^"]+)"|@'([^']+)'|@([^\s]+))/g;
  return [...text.matchAll(pattern)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5],
  );
}

// Expand @path references in a user message by inlining the referenced files'
// contents (resolved relative to workDir). Tokens that don't resolve to a small
// readable file are left untouched.
export function expandAtRefs(text: string, workDir: string): string {
  const refs = collectAtRefs(text);
  if (refs.length === 0) {
    return text;
  }

  let appendix = "";
  const seen = new Set<string>();
  for (const ref of refs) {
    if (seen.has(ref)) {
      continue;
    }
    seen.add(ref);
    const { path: refPath, lineStart, lineEnd } = parseRef(ref);
    const p = isAbsolute(refPath) ? refPath : join(workDir, refPath);
    try {
      const st = statSync(p);
      if (!st.isFile()) {
        continue;
      }
      if (lineStart !== undefined && lineEnd !== undefined) {
        if (st.size <= MAX_RANGE_FILE_BYTES) {
          const snippet = sliceLines(readFileSync(p, "utf-8"), lineStart, lineEnd);
          if (snippet.length <= MAX_INLINE_BYTES) {
            appendix += `\n\n<file path="${refPath}" lines="${String(lineStart)}-${String(lineEnd)}">\n${snippet}\n</file>`;
          }
        }
      } else if (st.size <= MAX_INLINE_BYTES) {
        appendix += `\n\n<file path="${ref}">\n${readFileSync(p, "utf-8")}\n</file>`;
      }
    } catch (err) {
      log.error({ err }, "UI operation failed");
      // not a readable file → leave the @token as literal text
    }
  }
  return appendix ? text + appendix : text;
}

// Like expandAtRefs, but @references to image files (png/jpg/gif/webp) are
// loaded as inline image content blocks instead of being inlined as (garbled)
// utf-8 text. The appendix gets an <image> placeholder so the model
// can pair each block with its @token. Image load failures are logged and
// skipped (only exceeding the per-message image limit appends an error note);
// non-image refs behave exactly like expandAtRefs.
// Returns a plain string when no image is referenced.
export async function expandAtRefsWithImages(
  text: string,
  workDir: string,
): Promise<string | Record<string, unknown>[]> {
  const refs = collectAtRefs(text);
  if (refs.length === 0) {
    return text;
  }

  let appendix = "";
  const seen = new Set<string>();
  const imageBlocks: Record<string, unknown>[] = [];
  for (const ref of refs) {
    if (seen.has(ref)) {
      continue;
    }
    seen.add(ref);
    const { path: refPath, lineStart, lineEnd } = parseRef(ref);
    const p = isAbsolute(refPath) ? refPath : join(workDir, refPath);
    try {
      const st = statSync(p);
      if (!st.isFile()) {
        continue;
      }
      if (isImagePath(p)) {
        if (imageBlocks.length >= MAX_IMAGES_PER_MESSAGE) {
          appendix += `\n\nError: too many images attached (limit ${String(MAX_IMAGES_PER_MESSAGE)} per message)`;
          continue;
        }
        try {
          const attachment = await loadImageAttachment(p);
          imageBlocks.push({
            type: "image",
            source: {
              type: "base64",
              media_type: attachment.mediaType,
              data: attachment.data,
            },
          });
          appendix += `\n\n<image type="base64" media_type="${attachment.mediaType}" path="${refPath}" />`;
        } catch (err) {
          log.error({ err: err }, "UI operation failed");
        }
      } else if (lineStart !== undefined && lineEnd !== undefined) {
        if (st.size <= MAX_RANGE_FILE_BYTES) {
          const snippet = sliceLines(readFileSync(p, "utf-8"), lineStart, lineEnd);
          if (snippet.length <= MAX_INLINE_BYTES) {
            appendix += `\n\n<file path="${refPath}" lines="${String(lineStart)}-${String(lineEnd)}">\n${snippet}\n</file>`;
          }
        }
      } else if (st.size <= MAX_INLINE_BYTES) {
        appendix += `\n\n<file path="${ref}">\n${readFileSync(p, "utf-8")}\n</file>`;
      }
    } catch (err) {
      log.error({ err }, "UI operation failed");
      // not a readable file → leave the @token as literal text
    }
  }
  const expanded = appendix ? text + appendix : text;
  if (imageBlocks.length === 0) {
    return expanded;
  }
  return [{ type: "text", text: expanded }, ...imageBlocks];
}
