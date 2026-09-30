import { type ReactNode, useState } from "react";

interface CollapsibleProps {
  header: ReactNode;
  children: ReactNode;
  /** Initial open state (uncontrolled); the component manages its own state afterwards. */
  defaultOpen?: boolean;
}

/**
 * Generic collapsible panel used by tool blocks and thinking blocks.
 * Pure Tailwind utilities — no custom CSS classes.
 */
export function Collapsible({
  header,
  children,
  defaultOpen = false,
}: CollapsibleProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border bg-surface shadow-xs">
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-[13px] transition-colors select-none hover:bg-tool"
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          aria-hidden="true"
          className={`shrink-0 text-dim transition-transform duration-200 ${open ? "rotate-90" : ""}`}
        >
          <path
            d="M3 1.5L7 5L3 8.5"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {header}
      </button>
      {open && (
        <div className="max-h-75 overflow-y-auto border-t border-border bg-tool/60 px-3 py-2 font-mono text-xs whitespace-pre-wrap text-dim">
          {children}
        </div>
      )}
    </div>
  );
}
