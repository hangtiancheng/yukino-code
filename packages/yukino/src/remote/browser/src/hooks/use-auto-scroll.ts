import { useEffect } from "react";
import { useStickToBottom } from "use-stick-to-bottom";

export function useAutoScroll(resetKey: string) {
  const { scrollRef, contentRef, isAtBottom, scrollToBottom } =
    useStickToBottom({
      initial: "instant",
      resize: "instant",
    });
  useEffect(() => {
    void scrollToBottom({ animation: "instant", ignoreEscapes: true });
  }, [resetKey, scrollToBottom]);
  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) {
      return;
    }
    const observer = new ResizeObserver(() => {
      void scrollToBottom({
        animation: "instant",
        preserveScrollPosition: true,
      });
    });
    observer.observe(viewport);
    return () => {
      observer.disconnect();
    };
  }, [scrollRef, scrollToBottom]);
  return {
    scrollRef,
    contentRef,
    atBottom: isAtBottom,
    scrollToBottom: () => {
      void scrollToBottom();
    },
  };
}
