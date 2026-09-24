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

import { relative } from "node:path";

import { useEffect, useRef } from "react";

import { connectToIde, type IdeConnection } from "@/vscode/ide-client.js";

export function useIdeInput(workDir: string) {
  const insertInputTextRef = useRef<((text: string) => void) | null>(null);
  const clearInputRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let connection: IdeConnection | null = null;
    let cancelled = false;
    const controller = new AbortController();
    void connectToIde({
      cwd: workDir,
      signal: controller.signal,
      onAtMentioned: ({ filePath, lineStart, lineEnd }) => {
        const rel = relative(workDir, filePath);
        const shown = rel && !rel.startsWith("..") ? rel : filePath;
        let mention = `@${shown}`;
        if (lineStart !== undefined) {
          mention += `#L${String(lineStart)}`;
          if (lineEnd !== undefined && lineEnd !== lineStart) {
            mention += `-${String(lineEnd)}`;
          }
        }
        insertInputTextRef.current?.(mention + " ");
      },
    }).then((connected) => {
      if (!connected) {
        return;
      }
      if (cancelled) {
        void connected.close();
        return;
      }
      connection = connected;
    });
    return () => {
      cancelled = true;
      controller.abort();
      void connection?.close();
    };
  }, [workDir]);

  return { insertInputTextRef, clearInputRef };
}
