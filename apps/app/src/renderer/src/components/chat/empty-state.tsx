// Shown before the first message: product identity plus quick-start hints.

import { SparklesIcon } from "lucide-react";
import { Button } from "@renderer/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@renderer/components/ui/empty";
import { Kbd, KbdGroup } from "@renderer/components/ui/kbd";

const hints = [
  "Explain this codebase",
  "Fix the failing tests",
  "Refactor the auth module",
];

export function EmptyState({
  onHint,
}: {
  onHint(text: string): void;
}): React.JSX.Element {
  return (
    <Empty className="border-0 bg-transparent px-6">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SparklesIcon />
        </EmptyMedia>
        <EmptyTitle>What are you working on?</EmptyTitle>
        <EmptyDescription>
          Yukino can read, edit, and run code in this workspace.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <div className="flex flex-wrap items-center justify-center gap-2">
          {hints.map((hint) => (
            <Button
              key={hint}
              variant="outline"
              size="sm"
              className="rounded-full"
              onClick={() => onHint(hint)}
            >
              {hint}
            </Button>
          ))}
        </div>
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
