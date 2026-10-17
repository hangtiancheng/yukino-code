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
    const previousFocus = document.activeElement;
    const controls = () =>
      Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input, textarea, select, a[href], [tabindex="0"]',
        ) ?? [],
      ).filter((element) => element.getClientRects().length > 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Tab") {
        const focusable = controls();
        const first = focusable[0];
        const last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last ||
            document.activeElement === panelRef.current)
        ) {
          event.preventDefault();
          first?.focus();
        }
        return;
      }
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
    (controls()[0] ?? panelRef.current)?.focus();
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus();
      }
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3 sm:p-4"
      role="presentation"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-label={label}
        aria-modal="true"
        tabIndex={-1}
        className={`animate-modal-in max-h-[85dvh] w-full ${maxWidth} flex flex-col overflow-hidden border-y border-rule bg-bg  outline-none`}
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
    <div className="border-b border-border px-4 sm:px-5 py-4">
      <h2 className="text-[15px] font-semibold text-accent">{title}</h2>
      {subtitle && <p className="mt-0.5 text-xs text-dim">{subtitle}</p>}
    </div>
  );
}
