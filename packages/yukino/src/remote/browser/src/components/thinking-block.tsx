import { useState } from "react";

import { Markdown } from "#/components/markdown.js";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "#/components/ui/collapsible.js";

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
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="my-3 border-l-2 border-border pl-3 text-xs leading-relaxed text-thinking"
    >
      <CollapsibleTrigger className="w-fit cursor-pointer hover:text-accent">
        {label}
        {streaming && (
          <span className="animate-blink ml-1 text-accent not-italic">▎</span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <Markdown className="mt-2" text={text || "(empty)"} />
      </CollapsibleContent>
    </Collapsible>
  );
}
