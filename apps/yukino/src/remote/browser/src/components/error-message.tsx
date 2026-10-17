export function ErrorMessage({ content }: { content: string }) {
  return (
    <div
      role="alert"
      className="my-4 px-3 whitespace-pre-wrap text-red sm:px-5"
    >
      {content}
    </div>
  );
}
