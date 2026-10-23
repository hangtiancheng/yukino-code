import { useCallback, useEffect, useRef, useState } from "react";

export function useAutoScroll<T extends HTMLElement>(
  dep: unknown,
  resetKey: string,
) {
  const ref = useRef<T | null>(null);
  const following = useRef(true);
  const frame = useRef<number | undefined>(undefined);
  const lastTop = useRef(0);
  const [atBottom, setAtBottom] = useState(true);

  const follow = useCallback(() => {
    if (frame.current !== undefined) {
      cancelAnimationFrame(frame.current);
    }
    frame.current = requestAnimationFrame(() => {
      frame.current = undefined;
      const el = ref.current;
      if (el && following.current) {
        el.scrollTop = el.scrollHeight;
        lastTop.current = el.scrollTop;
      }
    });
  }, []);

  const scrollToBottom = useCallback(() => {
    following.current = true;
    setAtBottom(true);
    follow();
  }, [follow]);

  useEffect(scrollToBottom, [resetKey, scrollToBottom]);
  useEffect(follow, [dep, follow]);

  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const pause = () => {
      following.current = false;
      setAtBottom(false);
    };
    let dragging = false;
    const onPointerDown = () => {
      dragging = true;
    };
    const onPointerUp = () => {
      dragging = false;
    };
    const onScroll = () => {
      const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
      const movingUp = el.scrollTop < lastTop.current;
      if (dragging && movingUp && !bottom) {
        pause();
      } else if (bottom && !movingUp) {
        following.current = true;
        setAtBottom(true);
      }
      lastTop.current = el.scrollTop;
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) {
        pause();
      }
    };
    let touchY = 0;
    const onTouchStart = (event: TouchEvent) => {
      touchY = event.touches[0]?.clientY ?? 0;
    };
    const onTouchMove = (event: TouchEvent) => {
      const nextY = event.touches[0]?.clientY ?? touchY;
      if (nextY > touchY) {
        pause();
      }
      touchY = nextY;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (["PageUp", "Home", "ArrowUp"].includes(event.key)) {
        pause();
      }
    };
    const observer = new ResizeObserver(follow);
    observer.observe(el);
    if (el.firstElementChild) {
      observer.observe(el.firstElementChild);
    }
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("keydown", onKeyDown);
    el.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      observer.disconnect();
      if (frame.current !== undefined) {
        cancelAnimationFrame(frame.current);
      }
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("keydown", onKeyDown);
      el.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [follow]);
  return { ref, atBottom, scrollToBottom };
}
