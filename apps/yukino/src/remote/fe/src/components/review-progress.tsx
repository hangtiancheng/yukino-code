import type { ReviewItem } from "@fe/types";

interface ReviewProgressProps {
  item: ReviewItem;
}

/** Live progress card for a code review run. */
export function ReviewProgress({ item }: ReviewProgressProps) {
  const percent =
    item.progress === null
      ? null
      : Math.max(0, Math.min(100, Math.round(item.progress * 100)));

  return (
    <div
      role="status"
      className={`my-3 rounded-xl border bg-surface px-4 py-3 shadow-xs ${
        item.done ? "border-border" : "border-accent/30"
      }`}
    >
      <div className="flex items-center gap-2 text-[13px]">
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 font-mono text-[11px] ${
            item.done ? "bg-green/10 text-green" : "bg-accent/10 text-accent"
          }`}
        >
          {item.done ? "review ✓" : item.phase}
        </span>
        <span className="min-w-0 flex-1 truncate text-base">
          {item.message}
        </span>
        {percent !== null && (
          <span className="shrink-0 font-mono text-[11px] text-dim tabular-nums">
            {`${String(percent)}%`}
          </span>
        )}
      </div>
      {!item.done && percent !== null && (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-border">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-300"
            style={{ width: `${String(percent)}%` }}
          />
        </div>
      )}
    </div>
  );
}
