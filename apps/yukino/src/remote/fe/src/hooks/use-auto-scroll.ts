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

import { useEffect, useRef, useState } from "react";

/**
 * Keeps a scroll container pinned to the bottom while new content streams in,
 * unless the user has scrolled up to read history.
 *
 * Returns a ref to attach to the scrollable element and the current auto-scroll
 * flag (useful for rendering a "jump to bottom" affordance).
 */
export function useAutoScroll<T extends HTMLElement>(dep: unknown) {
  const ref = useRef<T | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `dep` (the items array) intentionally triggers a re-scroll even though the effect body only reads DOM properties.
  useEffect(() => {
    const el = ref.current;
    if (!el || !autoScroll) {
      return;
    }
    // requestAnimationFrame ensures layout has settled before scrolling.
    const raf = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [dep, autoScroll]);

  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const onScroll = () => {
      const distanceFromBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight;
      setAutoScroll(distanceFromBottom < 60);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
    };
  }, []);

  return { ref, autoScroll, setAutoScroll };
}
