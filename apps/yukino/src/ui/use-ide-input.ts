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
