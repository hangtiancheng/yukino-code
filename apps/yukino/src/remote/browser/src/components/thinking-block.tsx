import { useState } from "react";

import { Markdown } from "./markdown";

interface ThinkingBlockProps {
  text: string;
  label: string;
  streaming?: boolean;
}

export function ThinkingBlock({
  text,
  label,
  streaming = false,
}: ThinkingBlockProps) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="my-4 text-thinking italic"
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
      }}
    >
      <summary className="w-fit cursor-pointer hover:text-accent">
        {label}
        {streaming && (
          <span className="animate-blink ml-1 text-accent not-italic">▎</span>
        )}
      </summary>
      {open && <Markdown className="mt-2" text={text || "(empty)"} />}
    </details>
  );
}
