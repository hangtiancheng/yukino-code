export function DiffLines({ text }: { text: string }) {
  return (
    <div className="overflow-x-auto whitespace-pre" aria-label="File changes">
      {text.split("\n").map((line, index) => (
        <div
          key={index}
          className={
            line.startsWith("+ ")
              ? "text-green"
              : line.startsWith("- ")
                ? "text-red"
                : "text-muted"
          }
        >
          {line || " "}
        </div>
      ))}
    </div>
  );
}
