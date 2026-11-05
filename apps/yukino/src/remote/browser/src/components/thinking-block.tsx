import { useState } from "react";

import { Markdown } from "#/components/markdown.js";

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
      className="my-3 border-l-2 border-border pl-3 text-xs leading-relaxed text-thinking"
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
