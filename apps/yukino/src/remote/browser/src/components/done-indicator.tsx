interface DoneIndicatorProps {
  elapsed: number;
}

export function DoneIndicator({ elapsed }: DoneIndicatorProps) {
  return (
    <div className="my-3 px-3 sm:px-5">
      <span className="flex items-center gap-1.5 text-xs text-muted">
        <span className="text-green" aria-hidden="true">
          ✓
        </span>
        Done in {elapsed.toFixed(1)}s
      </span>
    </div>
  );
}
