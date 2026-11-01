export function ErrorMessage({ content }: { content: string }) {
  return (
    <div
      role="alert"
      className="my-4 rounded-xl border border-red/30 bg-tool-error px-4 py-3 whitespace-pre-wrap text-red sm:px-5"
    >
      {content}
    </div>
  );
}
