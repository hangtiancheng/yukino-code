// Maps a single ChatState item to its row content. Chat primitives
// (Message/Bubble/Marker/Trace) compose the rows; special flows (permission,
// ask) render as cards. Row positioning/spacing is owned by ChatArea.

import { AskCard } from "@renderer/components/chat/ask-card";
import { Markdown } from "@renderer/components/chat/markdown";
import { PermissionCard } from "@renderer/components/chat/permission-card";
import { ToolCard } from "@renderer/components/chat/tool-card";
import { Bubble, BubbleContent } from "@renderer/components/ui/bubble";
import {
  Marker,
  MarkerIcon,
  MarkerContent,
} from "@renderer/components/ui/marker";
import {
  Message,
  MessageAvatar,
  MessageContent,
} from "@renderer/components/ui/message";
import { Spinner } from "@renderer/components/ui/spinner";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
} from "@renderer/components/ui/trace";
import type { ChatItem } from "@renderer/lib/chat-state";
import type { PermissionResponse } from "@shared/ipc-types";
import { AlertTriangleIcon, BotIcon, InfoIcon, UserIcon } from "lucide-react";

function AssistantRow({
  text,
  thinking,
  streaming,
}: {
  text: string;
  thinking: string;
  streaming: boolean;
}): React.JSX.Element {
  // The thinking trace is only "in progress" while the model is still
  // thinking — the moment text starts streaming, thinking is done.
  const thinkingActive = streaming && !text;
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
                <TraceLine status={thinkingActive ? "running" : undefined}>
                  <TraceIcon>
                    {thinkingActive ? <Spinner /> : <InfoIcon />}
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
            <BubbleContent className="w-full">
              <Markdown text={text} streaming={streaming} />
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
  // align="end" flips the row (flex-row-reverse), so the first DOM child sits
  // at the far right — avatar goes first to land on the right edge.
  return (
    <Message align="end">
      <MessageAvatar>
        <UserIcon className="size-4" />
      </MessageAvatar>
      <MessageContent>
        <Bubble variant="secondary" align="end">
          <BubbleContent className="whitespace-pre-wrap">{text}</BubbleContent>
        </Bubble>
      </MessageContent>
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
      return <UserRow text={item.text} />;

    case "assistant":
      return (
        <AssistantRow
          text={item.text}
          thinking={item.thinking}
          streaming={item.streaming}
        />
      );

    case "tool":
      // No avatar for tool calls; ChatArea indents the row under the
      // assistant content column and keeps consecutive calls tight.
      return <ToolCard item={item} />;

    case "system":
      return item.markdown ? (
        <div className="text-muted-foreground border-border bg-card w-full rounded-lg border px-4 py-3 text-xs">
          <Markdown text={item.text} streaming={false} />
        </div>
      ) : (
        <Marker>
          <MarkerIcon>
            <InfoIcon />
          </MarkerIcon>
          <MarkerContent className="text-xs whitespace-pre-wrap">
            {item.text}
          </MarkerContent>
        </Marker>
      );

    case "error":
      return (
        <Marker>
          <MarkerIcon>
            <AlertTriangleIcon className="text-destructive" />
          </MarkerIcon>
          <MarkerContent className="text-destructive text-xs whitespace-pre-wrap">
            {item.text}
          </MarkerContent>
        </Marker>
      );

    case "marker":
      return (
        <Marker variant="separator">
          <MarkerContent className="text-xs">{item.text}</MarkerContent>
        </Marker>
      );

    case "permission":
      return (
        <div className="flex justify-center">
          <PermissionCard item={item} onRespond={onRespondPermission} />
        </div>
      );

    case "ask":
      return (
        <div className="flex justify-center">
          <AskCard item={item} onRespond={onRespondAsk} />
        </div>
      );
  }
}
