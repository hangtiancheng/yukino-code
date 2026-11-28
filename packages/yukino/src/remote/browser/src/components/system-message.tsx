import { Markdown } from "#/components/markdown.js";

interface SystemMessageProps {
  content: string;
  markdown?: boolean;
}

export function SystemMessage({ content, markdown }: SystemMessageProps) {
  if (markdown) {
    return (
      <Markdown
        className="my-4 rounded-xl border border-custom-label/25 bg-custom px-4 py-3 text-custom-text sm:px-5"
        text={content}
      />
    );
  }
  return (
    <div className="my-4 rounded-xl border border-custom-label/25 bg-custom px-4 py-3 whitespace-pre-wrap text-custom-text sm:px-5">
      {content}
    </div>
  );
}
