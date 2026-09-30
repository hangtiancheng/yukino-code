interface SystemMessageProps {
  content: string;
}

export function SystemMessage({ content }: SystemMessageProps) {
  return (
    <div className="my-3 rounded-lg border border-border/70 bg-surface/60 px-3.5 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-dim">
      {content}
    </div>
  );
}
