// Maps a single ChatState item to its row representation. Chat primitives
// (Message/Bubble/Marker/Trace) compose the rows; special flows (permission,
// ask) render as cards.

import { cn } from "cn";
import { AlertTriangleIcon, BotIcon, InfoIcon, UserIcon } from "lucide-react";
import type { ChatItem } from "@renderer/lib/chat-state";
import type { PermissionResponse } from "@shared/ipc-types";
import {
  Message,
  MessageAvatar,
  MessageContent,
} from "@renderer/components/ui/message";
import { Bubble, BubbleContent } from "@renderer/components/ui/bubble";
import {
  Marker,
  MarkerIcon,
  MarkerContent,
} from "@renderer/components/ui/marker";
import { MessageScrollerItem } from "@renderer/components/ui/message-scroller";
import { Spinner } from "@renderer/components/ui/spinner";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
} from "@renderer/components/ui/trace";
import { ToolCard } from "@renderer/components/chat/tool-card";
import { PermissionCard } from "@renderer/components/chat/permission-card";
import { AskCard } from "@renderer/components/chat/ask-card";

function AssistantRow({
  text,
  thinking,
  streaming,
}: {
  text: string;
  thinking: string;
  streaming: boolean;
}): React.JSX.Element {
  return (
    <Message>
      <MessageAvatar>
        <BotIcon className="size-4" />
      </MessageAvatar>
      <MessageContent className="min-w-0 gap-2">
        {thinking ? (
          <Trace>
            <TraceCollapsible>
              <TraceCollapsibleTrigger>
                <TraceLine status={streaming ? "running" : undefined}>
                  <TraceIcon>
                    {streaming ? <Spinner /> : <InfoIcon />}
                  </TraceIcon>
                  <span data-slot="trace-title" className="text-xs">
                    Thinking
                  </span>
                </TraceLine>
              </TraceCollapsibleTrigger>
              <TraceCollapsibleContent className="max-h-64 overflow-auto font-mono text-xs whitespace-pre-wrap">
                {thinking}
              </TraceCollapsibleContent>
            </TraceCollapsible>
          </Trace>
        ) : null}
        {text ? (
          <Bubble variant="ghost">
            <BubbleContent className="text-[15px] leading-7 whitespace-pre-wrap">
              {text}
            </BubbleContent>
          </Bubble>
        ) : null}
        {streaming && !text && !thinking ? (
          <span className="text-muted-foreground flex items-center gap-2 text-sm">
            <Spinner />
          </span>
        ) : null}
      </MessageContent>
    </Message>
  );
}

function UserRow({ text }: { text: string }): React.JSX.Element {
  return (
    <Message align="end">
      <MessageContent>
        <Bubble variant="secondary" align="end">
          <BubbleContent className="whitespace-pre-wrap">{text}</BubbleContent>
        </Bubble>
      </MessageContent>
      <MessageAvatar>
        <UserIcon className="size-4" />
      </MessageAvatar>
    </Message>
  );
}

export function ChatItemRow({
  item,
  onRespondPermission,
  onRespondAsk,
}: {
  item: ChatItem;
  onRespondPermission: (id: string, response: PermissionResponse) => void;
  onRespondAsk: (id: string, answers: Record<string, string>) => void;
}): React.JSX.Element {
  switch (item.kind) {
    case "user":
      return (
        <MessageScrollerItem className="px-5 py-0.5">
          <UserRow text={item.text} />
        </MessageScrollerItem>
      );

    case "assistant":
      return (
        <MessageScrollerItem
          className="px-5 py-0.5"
          scrollAnchor={item.streaming}
        >
          <AssistantRow
            text={item.text}
            thinking={item.thinking}
            streaming={item.streaming}
          />
        </MessageScrollerItem>
      );

    case "tool":
      return (
        <MessageScrollerItem className="px-5 py-0.5">
          <Message>
            <MessageAvatar>
              <ToolGlyph name={item.toolName} />
            </MessageAvatar>
            <MessageContent className="gap-0">
              <ToolCard item={item} />
            </MessageContent>
          </Message>
        </MessageScrollerItem>
      );

    case "system":
      return (
        <MessageScrollerItem className="px-5 py-0.5">
          <Marker>
            <MarkerIcon>
              <InfoIcon />
            </MarkerIcon>
            <MarkerContent className="text-xs">{item.text}</MarkerContent>
          </Marker>
        </MessageScrollerItem>
      );

    case "error":
      return (
        <MessageScrollerItem className="px-5 py-0.5">
          <Marker>
            <MarkerIcon>
              <AlertTriangleIcon className="text-destructive" />
            </MarkerIcon>
            <MarkerContent className="text-destructive text-xs whitespace-pre-wrap">
              {item.text}
            </MarkerContent>
          </Marker>
        </MessageScrollerItem>
      );

    case "marker":
      return (
        <MessageScrollerItem className="px-5 py-0.5">
          <Marker variant="separator">
            <MarkerContent className="text-xs">{item.text}</MarkerContent>
          </Marker>
        </MessageScrollerItem>
      );

    case "permission":
      return (
        <MessageScrollerItem className="px-5 py-0.5" scrollAnchor>
          <div className={cn("flex justify-center")}>
            <PermissionCard item={item} onRespond={onRespondPermission} />
          </div>
        </MessageScrollerItem>
      );

    case "ask":
      return (
        <MessageScrollerItem className="px-5 py-0.5" scrollAnchor>
          <div className="flex justify-center">
            <AskCard item={item} onRespond={onRespondAsk} />
          </div>
        </MessageScrollerItem>
      );
  }
}

/** Per-tool avatar glyph so tool rows read at a glance. */
function ToolGlyph({ name }: { name: string }): React.JSX.Element {
  return (
    <span className="text-muted-foreground flex size-4 items-center justify-center text-[9px] font-semibold">
      {name.slice(0, 2).toUpperCase()}
    </span>
  );
}
