interface DoneIndicatorProps {
  elapsed: number;
}

export function DoneIndicator({ elapsed }: DoneIndicatorProps) {
  return (
    <div className="my-2 px-1">
      <span className="flex items-center gap-1.5 text-xs text-muted">
        <span className="text-green" aria-hidden="true">
          ✓
        </span>
        Done in {elapsed.toFixed(1)}s
      </span>
    </div>
  );
}
