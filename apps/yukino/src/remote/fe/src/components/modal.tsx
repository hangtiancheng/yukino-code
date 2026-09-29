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

import { type ReactNode, useEffect, useRef } from "react";

interface ModalProps {
  /** Accessible name of the dialog. */
  label: string;
  children: ReactNode;
  /** Invoked on Escape; omit to make the modal non-dismissible. */
  onEscape?: () => void;
  /** Tailwind max-width class for the panel. */
  maxWidth?: string;
}

/**
 * Centered overlay dialog. Backdrop clicks are intentionally inert — every
 * modal owns explicit buttons for its outcomes.
 */
export function Modal({
  label,
  children,
  onEscape,
  maxWidth = "max-w-lg",
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Latest callback in a ref: the keydown effect then runs once on mount.
  // With onEscape in the deps, every inline arrow (new identity per render)
  // would re-run the effect and refocus the panel — stealing focus from the
  // textarea after each keystroke.
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      // Don't hijack Escape while typing in a field inside the modal.
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "TEXTAREA" || target.tagName === "INPUT")
      ) {
        return;
      }
      onEscapeRef.current?.();
    };
    window.addEventListener("keydown", onKeyDown);
    panelRef.current?.focus();
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bright/25 p-4 backdrop-blur-[2px]"
      role="presentation"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-label={label}
        aria-modal="true"
        tabIndex={-1}
        className={`animate-modal-in max-h-[85vh] w-full ${maxWidth} flex flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-pop outline-none`}
      >
        {children}
      </div>
    </div>
  );
}

interface ModalHeaderProps {
  title: string;
  subtitle?: string;
}

export function ModalHeader({ title, subtitle }: ModalHeaderProps) {
  return (
    <div className="border-b border-border px-5 py-4">
      <h2 className="text-[15px] font-semibold text-bright">{title}</h2>
      {subtitle && <p className="mt-0.5 text-xs text-dim">{subtitle}</p>}
    </div>
  );
}
