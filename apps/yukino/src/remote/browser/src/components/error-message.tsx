export function ErrorMessage({ content }: { content: string }) {
  return (
    <div
      role="alert"
      className="my-4 rounded-xl border border-error/30 bg-error-bg px-4 py-3 whitespace-pre-wrap text-error sm:px-5"
    >
      {content}
    </div>
  );
}
