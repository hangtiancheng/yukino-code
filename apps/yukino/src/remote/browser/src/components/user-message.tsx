import { Markdown } from "#/components/markdown.js";

export function UserMessage({ content }: { content: string }) {
  return (
    <div className="user-message my-3 rounded-lg border border-border bg-user-bg px-3 py-2.5 text-user-text">
      <Markdown text={content} user />
    </div>
  );
}
