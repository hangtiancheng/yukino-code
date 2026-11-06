import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@renderer/components/ui/collapsible";
import { ChevronRightIcon } from "lucide-react";

export function ErrorDetails({
  children,
}: {
  children: string;
}): React.JSX.Element {
  return (
    <Collapsible className="[&_pre]:bg-muted [&_pre]:text-muted-foreground w-full max-w-full min-w-0 wrap-anywhere [&_pre]:mt-2.5 [&_pre]:max-h-40 [&_pre]:overflow-auto [&_pre]:rounded-[6px] [&_pre]:p-3 [&_pre]:text-[11px] [&_pre]:wrap-anywhere [&_pre]:whitespace-pre-wrap [&_pre]:select-text">
      <CollapsibleTrigger className="group text-muted-foreground flex items-center gap-1.5 text-xs">
        <ChevronRightIcon className="size-3 transition-transform group-data-panel-open:rotate-90" />
        查看详情
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre>{children}</pre>
      </CollapsibleContent>
    </Collapsible>
  );
}
