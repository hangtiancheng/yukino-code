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
              ? "bg-green/5 text-green"
              : line.startsWith("- ")
                ? "bg-red/5 text-red"
                : "text-muted"
          }
        >
          {line || " "}
        </div>
      ))}
    </div>
  );
}
