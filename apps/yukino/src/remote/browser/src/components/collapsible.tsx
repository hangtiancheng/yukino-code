import { type ReactNode, useState } from "react";

interface CollapsibleProps {
  header: ReactNode;
  children: ReactNode;
  preview?: ReactNode;
  className: string;
}

export function Collapsible({
  header,
  children,
  preview,
  className,
}: CollapsibleProps) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className={`tool-card my-3 overflow-hidden rounded-xl border py-2 ${className}`}
    >
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-2 px-4 py-1.5 text-left transition-colors select-none hover:bg-selected sm:px-5"
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
      {(open || preview) && (
        <div className="overflow-x-auto border-t border-border px-4 py-2 font-mono text-xs leading-6 whitespace-pre-wrap text-tool-output sm:px-5">
          {open ? children : preview}
        </div>
      )}
    </div>
  );
}
