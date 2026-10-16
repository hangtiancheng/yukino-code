import { useCallback, useEffect, useRef } from "react";

/**
 * Keeps the cursor row of a keyboard-navigated dropdown in view while the user
 * presses ↑/↓: the list scrolls the minimum distance needed to reveal the row
 * (the browser-native select behavior). Manual scrollTop math instead of
 * scrollIntoView so ancestor scrollers (the message log) never move.
 */
export function useScrollFollow(cursor: number) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<(HTMLElement | null)[]>([]);

  const setItemRef = useCallback(
    (index: number) => (el: HTMLElement | null) => {
      itemRefs.current[index] = el;
    },
    [],
  );

  useEffect(() => {
    const list = listRef.current;
    const item = itemRefs.current[cursor];
    if (!list || !item) {
      return;
    }
    const top = item.offsetTop;
    const bottom = top + item.offsetHeight;
    if (top < list.scrollTop) {
      list.scrollTop = top;
    } else if (bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = bottom - list.clientHeight;
    }
  }, [cursor]);

  return { listRef, setItemRef };
}
