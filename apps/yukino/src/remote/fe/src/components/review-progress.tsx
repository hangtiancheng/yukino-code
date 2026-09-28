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

import type { ReviewItem } from "@fe/types";

interface ReviewProgressProps {
  item: ReviewItem;
}

/** Live progress card for a code review run. */
export function ReviewProgress({ item }: ReviewProgressProps) {
  const percent =
    item.progress === null
      ? null
      : Math.max(0, Math.min(100, Math.round(item.progress * 100)));

  return (
    <div
      role="status"
      className={`my-3 rounded-xl border bg-surface px-4 py-3 shadow-xs ${
        item.done ? "border-border" : "border-accent/30"
      }`}
    >
      <div className="flex items-center gap-2 text-[13px]">
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 font-mono text-[11px] ${
            item.done ? "bg-green/10 text-green" : "bg-accent/10 text-accent"
          }`}
        >
          {item.done ? "review ✓" : item.phase}
        </span>
        <span className="min-w-0 flex-1 truncate text-base">
          {item.message}
        </span>
        {percent !== null && (
          <span className="shrink-0 font-mono text-[11px] text-dim tabular-nums">
            {`${String(percent)}%`}
          </span>
        )}
      </div>
      {!item.done && percent !== null && (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-border">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-300"
            style={{ width: `${String(percent)}%` }}
          />
        </div>
      )}
    </div>
  );
}
