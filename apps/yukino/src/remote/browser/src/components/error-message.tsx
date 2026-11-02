export function ErrorMessage({ content }: { content: string }) {
  return (
    <div
      role="alert"
      className="my-2 rounded-lg border border-red/30 bg-tool-error px-3 py-2 whitespace-pre-wrap text-red"
    >
      {content}
    </div>
  );
}
