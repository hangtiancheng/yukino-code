interface DoneIndicatorProps {
  elapsed: number;
}

export function DoneIndicator({ elapsed }: DoneIndicatorProps) {
  return (
    <div className="my-3 flex justify-center">
      <span className="rounded-full border border-border bg-surface px-3 py-1 text-[11px] text-dim shadow-xs">
        ✻ Done in {elapsed.toFixed(1)}s
      </span>
    </div>
  );
}
