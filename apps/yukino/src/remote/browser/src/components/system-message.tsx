import { renderMarkdown } from "@browser/lib/markdown";

interface SystemMessageProps {
  content: string;
  markdown?: boolean;
}

export function SystemMessage({ content, markdown }: SystemMessageProps) {
  if (markdown) {
    return (
      <div
        className="my-3 rounded-lg border border-border/70 bg-surface/60 px-3.5 py-2 text-xs leading-relaxed text-dim [&_code]:rounded [&_code]:bg-code [&_code]:px-1 [&_code]:font-mono [&_p]:my-1 [&_strong]:text-bright [&_table]:my-1.5 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:px-2.5 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:bg-tool [&_th]:px-2.5 [&_th]:py-1 [&_th]:text-left [&_th]:font-semibold [&_th]:text-bright"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
      />
    );
  }
  return (
    <div className="my-3 rounded-lg border border-border/70 bg-surface/60 px-3.5 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-dim">
      {content}
    </div>
  );
}
