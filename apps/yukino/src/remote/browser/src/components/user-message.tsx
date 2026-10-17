import { Markdown } from "./markdown";

export function UserMessage({ content }: { content: string }) {
  return (
    <div className="my-4 bg-user-bg px-3 py-3 text-user-text sm:px-5">
      <Markdown text={content} user />
    </div>
  );
}
