import { ChevronRightIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import {
  Collapsible as CollapsibleRoot,
  CollapsibleTrigger,
  CollapsibleContent,
} from "#/components/ui/collapsible.js";

interface CollapsibleProps {
  header: ReactNode;
  children: ReactNode;
  preview?: ReactNode;
  className: string;
}

export function Collapsible({
  header,
  children,
  preview,
  className,
}: CollapsibleProps) {
  const [open, setOpen] = useState(false);
  return (
    <CollapsibleRoot
      open={open}
      onOpenChange={setOpen}
      className={`tool-card my-3 overflow-hidden rounded-xl border py-2 ${className}`}
    >
      <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-2 px-4 py-1.5 text-left transition-colors select-none hover:bg-selected sm:px-5">
        <ChevronRightIcon
          size={10}
          aria-hidden="true"
          className={`shrink-0 text-dim transition-transform duration-200 ${open ? "rotate-90" : ""}`}
        />
        {header}
      </CollapsibleTrigger>
      {!open && preview && (
        <div className="overflow-x-auto border-t border-border px-4 py-2 font-mono text-xs leading-6 whitespace-pre-wrap text-tool-output sm:px-5">
          {preview}
        </div>
      )}
      <CollapsibleContent className="overflow-x-auto border-t border-border px-4 py-2 font-mono text-xs leading-6 whitespace-pre-wrap text-tool-output sm:px-5">
        {children}
      </CollapsibleContent>
    </CollapsibleRoot>
  );
}
