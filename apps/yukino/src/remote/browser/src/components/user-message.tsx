import { Markdown } from "#/components/markdown.js";

export function UserMessage({ content }: { content: string }) {
  return (
    <div className="user-message my-5 rounded-xl border border-border bg-user-bg px-4 py-3.5 text-user-text sm:px-5">
      <Markdown text={content} user />
    </div>
  );
}
