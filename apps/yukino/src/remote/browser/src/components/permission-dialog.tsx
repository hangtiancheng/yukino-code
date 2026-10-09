import type { PermissionItem, PermissionResponse } from "@browser/types";

interface PermissionDialogProps {
  item: PermissionItem;
  onRespond: (id: string, response: PermissionResponse) => void;
}

const RESPONSE_OPTIONS: {
  value: PermissionResponse;
  label: string;
  className: string;
}[] = [
  {
    value: "allow",
    label: "Allow",
    className: "bg-accent text-accent-contrast shadow-xs hover:bg-accent-dim",
  },
  {
    value: "allowAlways",
    label: "Allow Pattern for All Project Agents",
    className: "border border-accent/40 text-accent hover:bg-accent/8",
  },
  {
    value: "deny",
    label: "Deny",
    className: "border border-red/30 text-red hover:bg-red/6",
  },
];

export function PermissionDialog({ item, onRespond }: PermissionDialogProps) {
  return (
    <section
      aria-label={`Permission required for ${item.toolName}`}
      className="my-3 rounded-xl border border-yellow/35 bg-surface p-4 shadow-xs"
    >
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-yellow">
        <svg
          width="13"
          height="13"
          viewBox="0 0 13 13"
          fill="none"
          aria-hidden="true"
        >
          <rect
            x="2"
            y="5.5"
            width="9"
            height="6"
            rx="1.2"
            stroke="currentColor"
            strokeWidth="1.4"
          />
          <path
            d="M4 5.5V4a2.5 2.5 0 015 0v1.5"
            stroke="currentColor"
            strokeWidth="1.4"
          />
        </svg>
        Permission Required: <span className="font-mono">{item.toolName}</span>
      </div>
      <div className="mb-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-base">
        {item.description}
      </div>
      {item.responded ? (
        <div className="text-xs text-dim">
          <span className="mr-1 text-green">✓</span> Permission: {item.response}
        </div>
      ) : (
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {RESPONSE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => {
                onRespond(item.id, opt.value);
              }}
              className={`w-full cursor-pointer rounded-lg px-4 py-2 text-[13px] font-semibold transition-colors sm:w-auto sm:py-1.5 ${opt.className}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
