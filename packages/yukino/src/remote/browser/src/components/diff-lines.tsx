export function DiffLines({ text }: { text: string }) {
  return (
    <div
      className="overflow-x-auto font-mono whitespace-pre"
      aria-label="File changes"
    >
      {text.split("\n").map((line, index) => (
        <div
          key={index}
          className={
            line.startsWith("+ ")
              ? "bg-success-bg text-diff-added"
              : line.startsWith("- ")
                ? "bg-error-bg text-diff-removed"
                : "text-diff-context"
          }
        >
          {line || " "}
        </div>
      ))}
    </div>
  );
}
