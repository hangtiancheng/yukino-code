import { Markdown } from "#/components/markdown.js";

interface SystemMessageProps {
  content: string;
  markdown?: boolean;
}

export function SystemMessage({ content, markdown }: SystemMessageProps) {
  if (markdown) {
    return (
      <Markdown
        className="my-2 border-l-2 border-border pl-3 text-muted"
        text={content}
      />
    );
  }
  return (
    <div className="my-2 border-l-2 border-border pl-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted">
      {content}
    </div>
  );
}
