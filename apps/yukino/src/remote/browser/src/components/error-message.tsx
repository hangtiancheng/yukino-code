interface ErrorMessageProps {
  content: string;
}

export function ErrorMessage({ content }: ErrorMessageProps) {
  return (
    <div
      role="alert"
      className="my-3 flex items-start gap-2.5 rounded-lg border border-red/25 bg-red/5 px-3.5 py-2.5 text-sm text-red"
    >
      <svg
        className="mt-0.5 shrink-0"
        width="14"
        height="14"
        viewBox="0 0 14 14"
        fill="none"
        aria-hidden="true"
      >
        <circle
          cx="7"
          cy="7"
          r="6.25"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path
          d="M5 5l4 4M9 5l-4 4"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
      <span className="min-w-0 whitespace-pre-wrap">{content}</span>
    </div>
  );
}
