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
    <Collapsible className="error-details">
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
