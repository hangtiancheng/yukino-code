import { useEffect, useRef, useState } from "react";

/**
 * Keeps a scroll container pinned to the bottom while new content streams in,
 * unless the user has scrolled up to read history.
 *
 * Returns a ref to attach to the scrollable element, the current auto-scroll
 * flag, and its setter (useful for rendering a "jump to bottom" affordance).
 */
export function useAutoScroll<T extends HTMLElement>(dep: unknown) {
  const ref = useRef<T | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);

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
