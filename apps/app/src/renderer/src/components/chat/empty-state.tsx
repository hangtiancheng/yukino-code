// Shown before the first message: product identity plus a send-hint row.

import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@renderer/components/ui/empty";
import { Kbd, KbdGroup } from "@renderer/components/ui/kbd";
import { SparklesIcon } from "lucide-react";

export function EmptyState(): React.JSX.Element {
  return (
    <Empty className="border-0 bg-transparent px-6">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SparklesIcon />
        </EmptyMedia>
        <EmptyTitle>What are you working on?</EmptyTitle>
      </EmptyHeader>
      <EmptyContent>
        <KbdGroup className="text-muted-foreground mt-2">
          <Kbd>Enter</Kbd>
          <span className="text-xs">to send</span>
          <Kbd>Shift</Kbd>
          <span className="text-xs">+</span>
          <Kbd>Enter</Kbd>
          <span className="text-xs">for a new line</span>
        </KbdGroup>
      </EmptyContent>
    </Empty>
  );
}
