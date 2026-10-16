import { useCallback, useEffect, useRef, useState } from "react";

interface AutoScroll<T extends HTMLElement> {
  /** Attach to the scrollable element. */
  ref: React.RefObject<T | null>;
  /** Whether the viewport is currently pinned to the bottom. */
  atBottom: boolean;
  /** Programmatically pin the viewport back to the bottom. */
  scrollToBottom: () => void;
}

/**
 * Keeps a scroll container pinned to the bottom while new content streams in,
 * unless the user has scrolled up to read history.
 */
export function useAutoScroll<T extends HTMLElement>(
  dep: unknown,
): AutoScroll<T> {
  const ref = useRef<T | null>(null);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    const el = ref.current;
    if (!el || !atBottom) {
      return;
    }
    // requestAnimationFrame ensures layout has settled before scrolling.
    const raf = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [dep, atBottom]);

  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const onScroll = () => {
      const distanceFromBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight;
      setAtBottom(distanceFromBottom < 60);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
    };
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    el.scrollTop = el.scrollHeight;
    setAtBottom(true);
  }, []);

  return { ref, atBottom, scrollToBottom };
}
