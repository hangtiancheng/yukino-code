// Virtualized chat surface built on @tanstack/react-virtual. The scroll
// viewport spans the full width of the chat column so the scrollbar sits at
// the app's right edge; rows are centered in a max-w-4xl column inside.
// Auto-scroll sticks to the bottom while the user hasn't scrolled away, so
// streaming output keeps the view pinned without fighting the user.

import { ChatItemRow } from "@renderer/components/chat/chat-item";
import { Button } from "@renderer/components/ui/button";
import { Spinner } from "@renderer/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@renderer/components/ui/tooltip";
import type { ChatItem } from "@renderer/lib/chat-state";
import type { PermissionResponse } from "@shared/ipc-types";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "cn";
import { ArrowDownIcon } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

/** Distance from the bottom (px) that still counts as "following". */
const STICK_THRESHOLD = 32;

/** Trailing space so the last rows clear the floating composer overlay. */
const COMPOSER_CLEARANCE = 168;

/** Gap between the scroll-to-latest button and the top of the composer overlay. */
const SCROLL_BUTTON_GAP = 8;

/** Vertical rhythm per row; consecutive tool calls stay visually tight. */
function rowSpacing(item: ChatItem, prev: ChatItem | null): string {
  if (item.kind === "tool") {
    return prev?.kind === "tool" ? "pb-0.5" : "pt-2 pb-0.5";
  }
  if (prev?.kind === "tool") {
    return "pt-2 pb-1";
  }
  return "py-1";
}

function StreamingIndicator({
  subagents,
}: {
  subagents: number;
}): React.JSX.Element {
  return (
    <div className="text-muted-foreground flex items-center gap-2 px-5 py-2 text-xs">
      <Spinner />
      {subagents > 0
        ? `${subagents} subagent${subagents > 1 ? "s" : ""} working…`
        : "Working…"}
    </div>
  );
}

export function ChatArea({
  items,
  streaming,
  activeSubagents,
  overlayHeight = 0,
  onRespondPermission,
  onRespondAsk,
}: {
  items: ChatItem[];
  streaming: boolean;
  activeSubagents: number;
  /** Measured height of the floating composer overlay (px). The
   *  scroll-to-latest button is lifted above it so it is never covered. */
  overlayHeight?: number;
  onRespondPermission: (id: string, response: PermissionResponse) => void;
  onRespondAsk: (id: string, answers: Record<string, string>) => void;
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  // The streaming indicator rides along as a trailing virtual row.
  const rowCount = items.length + (streaming ? 1 : 0);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 120,
    overscan: 6,
  });

  // Keep the view pinned to the bottom while following. Runs after every
  // render so streaming text growth and row re-measurement both stick.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  });

  // When the list shrinks (new session / resume / folder change), snap the
  // follow state back on so the fresh view starts pinned.
  const prevCount = useRef(rowCount);
  useLayoutEffect(() => {
    if (rowCount < prevCount.current) {
      stickRef.current = true;
      setAtBottom(true);
    }
    prevCount.current = rowCount;
  }, [rowCount]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const stick =
      el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD;
    stickRef.current = stick;
    setAtBottom(stick);
  }, []);

  const scrollToBottom = useCallback(() => {
    stickRef.current = true;
    setAtBottom(true);
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, []);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        role="log"
        aria-label="Messages"
        className="min-h-0 flex-1 scrollbar-thin overflow-y-auto overscroll-contain"
      >
        {/* Trailing space clears the floating composer overlay. */}
        <div
          className="relative w-full"
          style={{ height: virtualizer.getTotalSize() + COMPOSER_CLEARANCE }}
        >
          {virtualizer.getVirtualItems().map((vrow) => {
            const isIndicator = streaming && vrow.index === items.length;
            const item = isIndicator ? null : items[vrow.index];
            const prev =
              !isIndicator && vrow.index > 0 ? items[vrow.index - 1] : null;
            return (
              <div
                key={isIndicator ? "__streaming__" : item?.id}
                data-index={vrow.index}
                ref={virtualizer.measureElement}
                className="absolute top-0 left-0 w-full"
                style={{ transform: `translateY(${vrow.start}px)` }}
              >
                <div className="mx-auto w-full max-w-4xl">
                  {isIndicator ? (
                    <StreamingIndicator subagents={activeSubagents} />
                  ) : item ? (
                    <div
                      className={cn(
                        "px-5",
                        // Tool rows have no avatar; indent them under the
                        // assistant content column (avatar 32px + gap 8px).
                        item.kind === "tool" ? "pl-15" : "",
                        rowSpacing(item, prev),
                      )}
                    >
                      <ChatItemRow
                        item={item}
                        onRespondPermission={onRespondPermission}
                        onRespondAsk={onRespondAsk}
                      />
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="secondary"
              size="icon-sm"
              onClick={scrollToBottom}
              tabIndex={atBottom ? -1 : 0}
              // Lift the button above the floating composer overlay so it is
              // never painted behind it (the overlay is later in DOM order).
              style={{ bottom: overlayHeight + SCROLL_BUTTON_GAP }}
              className={cn(
                "border-border bg-background absolute inset-x-1/2 -translate-x-1/2 rounded-full transition-[opacity,scale] duration-200",
                atBottom
                  ? "pointer-events-none scale-95 opacity-0"
                  : "opacity-100",
              )}
            />
          }
        >
          <ArrowDownIcon />
          <span className="sr-only">Scroll to latest</span>
        </TooltipTrigger>
        <TooltipContent>Scroll to latest</TooltipContent>
      </Tooltip>
    </div>
  );
}
