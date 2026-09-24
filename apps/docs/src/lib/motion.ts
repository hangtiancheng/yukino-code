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

import { animate, inView } from "motion";
import type { AnimationOptions, DOMKeyframesDefinition } from "motion";

export const EASE = [0.22, 1, 0.36, 1] as const;

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Whether the visitor asked the OS to reduce motion. JS-driven animations must
 * consult this (the CSS media query only covers CSS animations): helpers below
 * collapse to duration 0, and looping/typing animations skip entirely.
 */
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

/**
 * Animates every `[data-reveal]` descendant of `root` once it scrolls into
 * view. Elements carry the Tailwind `opacity-0` class until animated; offsets
 * and timing come from `data-reveal-x/-y/-delay/-duration`. Safe to call
 * repeatedly (e.g. from `updated()`) — already-registered elements are skipped.
 */
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
