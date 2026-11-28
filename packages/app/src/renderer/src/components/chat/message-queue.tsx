import { Button } from "@renderer/components/ui/button";
import type { QueuedMessage } from "@shared/agent-types";
import { ListOrderedIcon, PencilIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export function MessageQueue({
  entries,
  onRecall,
}: {
  entries: QueuedMessage[];
  onRecall: (text: string) => void;
}): React.JSX.Element | null {
  const [pending, setPending] = useState<string | null>(null);
  if (!entries.length) {
    return null;
  }
  const remove = async (id: string, recall: boolean): Promise<void> => {
    setPending(id);
    try {
      const text = await window.api.cancelQueuedMessage(id);
      if (recall) {
        onRecall(text);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(null);
    }
  };
  return (
    <details className="bg-muted/45 mb-2.5 rounded-xl border" open>
      <summary className="text-muted-foreground flex cursor-pointer items-center gap-2 px-3 py-2 text-xs select-none">
        <ListOrderedIcon className="text-accent-foreground size-3.5" />
        {entries.length} queued {entries.length === 1 ? "message" : "messages"}
      </summary>
      <ul
        aria-label="Queued messages"
        className="max-h-32 overflow-y-auto overscroll-contain px-1.5 pb-1.5"
      >
        {entries.map((entry) => (
          <li
            className="bg-card/80 flex min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-xs"
            key={entry.id}
          >
            <span className="text-accent-foreground shrink-0 text-[10px]">
              {entry.kind === "steer" ? "Steer" : "Follow-up"}
            </span>
            <span className="min-w-0 flex-1 truncate" title={entry.text}>
              {entry.text || `${entry.attachmentCount} image attachments`}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={pending !== null}
              aria-label="Edit queued message"
              title="Move to composer"
              onClick={() => {
                void remove(entry.id, true);
              }}
            >
              <PencilIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={pending !== null}
              aria-label="Remove queued message"
              title="Remove from queue"
              onClick={() => {
                void remove(entry.id, false);
              }}
            >
              <XIcon />
            </Button>
          </li>
        ))}
      </ul>
    </details>
  );
}
