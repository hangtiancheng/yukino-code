import { animate, inView } from "motion";
import type { AnimationOptions, DOMKeyframesDefinition } from "motion";

export const EASE = [0.22, 1, 0.36, 1] as const;

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function animateIn(
  el: HTMLElement,
  keyframes: DOMKeyframesDefinition,
  options?: AnimationOptions,
) {
  return animate(
    el,
    keyframes,
    prefersReducedMotion() ? { duration: 0 } : options,
  );
}

export async function animateOut(
  el: HTMLElement,
  keyframes: DOMKeyframesDefinition,
  options?: AnimationOptions,
) {
  await animate(
    el,
    keyframes,
    prefersReducedMotion() ? { duration: 0 } : options,
  ).finished;
}

export function onceInView(
  el: HTMLElement,
  onEnter: () => void,
  margin?: string,
) {
  let done = false;
  const stop = inView(
    el,
    () => {
      if (done) return;
      done = true;
      onEnter();
      stop();
    },
    margin === undefined
      ? undefined
      : ({ margin } as Parameters<typeof inView>[2]),
  );
  return stop;
}

export function flipTo(el: HTMLElement, first: DOMRect) {
  const last = el.getBoundingClientRect();
  const dx = first.left - last.left;
  const dy = first.top - last.top;
  const sx = last.width === 0 ? 1 : first.width / last.width;
  const sy = last.height === 0 ? 1 : first.height / last.height;
  if (dx === 0 && dy === 0 && sx === 1 && sy === 1) return;
  animate(
    el,
    { x: [dx, 0], y: [dy, 0], scaleX: [sx, 1], scaleY: [sy, 1] },
    { type: "spring", stiffness: 400, damping: 32 },
  );
}

const revealed = new WeakSet<Element>();

export function setupReveals(root: ParentNode) {
  const elements = root.querySelectorAll<HTMLElement>("[data-reveal]");
  const reduced = prefersReducedMotion();
  for (const el of Array.from(elements)) {
    if (revealed.has(el)) continue;
    revealed.add(el);
    if (reduced) {
      el.style.opacity = "1";
      continue;
    }
    const x = Number(el.dataset.revealX ?? 0);
    const y = Number(el.dataset.revealY ?? 12);
    const delay = Number(el.dataset.revealDelay ?? 0);
    const duration = Number(el.dataset.revealDuration ?? 0.45);
    onceInView(el, () => {
      const keyframes: DOMKeyframesDefinition = { opacity: [0, 1] };
      if (x !== 0) keyframes.x = [x, 0];
      if (y !== 0) keyframes.y = [y, 0];
      animate(el, keyframes, { duration, delay, ease: EASE });
    });
  }
}
