import { RESPONSE_LABEL, RESPONSE_OPTIONS } from "#/constants.js";
import type { PermissionItem, PermissionResponse } from "#/types.js";

interface PermissionDialogProps {
  item: PermissionItem;
  onRespond: (id: string, response: PermissionResponse) => void;
}

export function PermissionDialog({ item, onRespond }: PermissionDialogProps) {
  return (
    <section
      aria-label={`Permission required for ${item.toolName}`}
      className="my-3 rounded-none border border-yellow/35 bg-surface p-4 "
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
      {item.rememberPatterns?.map((pattern) => (
        <div
          key={pattern}
          className="mb-2 font-mono text-xs whitespace-pre-wrap break-all"
        >
          Remember scope: {pattern}
        </div>
      ))}
      {item.responded ? (
        <div className="text-xs text-dim">
          <span className="mr-1 text-green">✓</span>
          {RESPONSE_LABEL[item.response ?? ""] ?? item.response}
        </div>
      ) : (
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {RESPONSE_OPTIONS.filter(
            (option) =>
              option.value !== "allowAlways" ||
              (item.rememberPatterns?.length ?? 0) > 0,
          ).map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => {
                onRespond(item.id, opt.value);
              }}
              className={`w-full cursor-pointer rounded-none px-4 py-2 text-[13px] font-semibold transition-colors sm:w-auto sm:py-1.5 ${opt.className}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
