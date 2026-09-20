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

import { argsPreview, formatArgs, truncateOutput } from "@fe/lib/format";
import type { ToolItem } from "@fe/types";

import { Collapsible } from "./collapsible";

interface ToolBlockProps {
  item: ToolItem;
}

const STATUS_META: Record<ToolItem["status"], { label: string; className: string }> = {
  running: {
    label: "running...",
    className: "animate-pulse bg-yellow/10 text-yellow",
  },
  ok: { label: "✓", className: "bg-green/10 text-green" },
  err: { label: "✗", className: "bg-red/10 text-red" },
};

export function ToolBlock({ item }: ToolBlockProps) {
  const meta = STATUS_META[item.status];
  const statusText =
    item.status === "running" ? meta.label : `${meta.label} ${item.elapsed.toFixed(1)}s`;
  const preview = argsPreview(item.args);
  const argsStr = formatArgs(item.args);
  const output = item.output ? truncateOutput(item.output) : "";

  return (
    <Collapsible
      header={
        <>
          <span className="font-mono font-semibold text-accent">{item.toolName}</span>
          {preview && (
            <span className="ml-0.5 max-w-105 overflow-hidden font-mono text-xs text-ellipsis whitespace-nowrap text-dim">
              {preview}
            </span>
          )}
          <span
            className={`ml-auto shrink-0 rounded-full px-2 py-0.5 font-mono text-[11px] tabular-nums ${meta.className}`}
          >
            {statusText}
          </span>
        </>
      }
    >
      {argsStr && (
        <div className="mb-2 text-accent/90">
          Args:{"\n"}
          {argsStr}
        </div>
      )}
      {output && <div className="text-dim">{output}</div>}
    </Collapsible>
  );
}
