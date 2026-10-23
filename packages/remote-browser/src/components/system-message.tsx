import { Markdown } from "#/components/markdown.js";

interface SystemMessageProps {
  content: string;
  markdown?: boolean;
}

export function SystemMessage({ content, markdown }: SystemMessageProps) {
  if (markdown) {
    return <Markdown className="my-4 px-3 text-muted sm:px-5" text={content} />;
  }
  return (
    <div className="my-4 px-3 whitespace-pre-wrap text-muted sm:px-5">
      {content}
    </div>
  );
}
