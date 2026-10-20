import { memo } from "react";

import { AskUserDialog } from "#/components/ask-user-dialog.js";
import { AssistantMessage } from "#/components/assistant-message.js";
import { DoneIndicator } from "#/components/done-indicator.js";
import { ErrorMessage } from "#/components/error-message.js";
import { PermissionDialog } from "#/components/permission-dialog.js";
import { ReviewProgress } from "#/components/review-progress.js";
import { SystemMessage } from "#/components/system-message.js";
import { ThinkingBlock } from "#/components/thinking-block.js";
import { ToolBlock } from "#/components/tool-block.js";
import { UserMessage } from "#/components/user-message.js";
import { Welcome, type WelcomeInfo } from "#/components/welcome.js";
import { useAutoScroll } from "#/hooks/use-auto-scroll.js";
import type { ChatItem } from "#/types.js";

interface MessageListProps {
  items: ChatItem[];
  revision: number;
  /** Session snapshot for the empty-state panel. */
  welcome: WelcomeInfo;
  onRespondPermission: (
    id: string,
    response: "allow" | "deny" | "allowAlways",
  ) => void;
  onAnswerAsk: (id: string, answers: Record<string, string>) => void;
}

export function MessageList({
  items,
  revision,
  welcome,
  onRespondPermission,
  onAnswerAsk,
}: MessageListProps) {
  const { ref, atBottom, scrollToBottom } = useAutoScroll<HTMLDivElement>(
    items,
    `${welcome.session}:${String(revision)}`,
  );

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={ref}
        role="log"
        aria-live="polite"
        tabIndex={0}
        className="h-full overflow-y-auto overscroll-contain focus-visible:-outline-offset-2"
      >
        <div className="w-full py-1">
          <Welcome {...welcome} empty={items.length === 0} />
          {items.map((item) => (
            <MessageRow
              key={item.id}
              item={item}
              onRespondPermission={onRespondPermission}
              onAnswerAsk={onAnswerAsk}
            />
          ))}
        </div>
      </div>
      {!atBottom && items.length > 0 && (
        <button
          type="button"
          onClick={scrollToBottom}
          aria-label="Scroll to the latest message"
          title="Scroll to the latest message"
          className="absolute bottom-4 left-1/2 z-10 flex h-8 w-8 -translate-x-1/2 cursor-pointer items-center justify-center rounded-full border border-border bg-surface text-dim  transition-colors hover:text-bright"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
            <path
              d="M8 3v10m0 0 4.2-4.2M8 13l-4.2-4.2"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}
    </div>
  );
}

const MessageRow = memo(function MessageRow({
  item,
  onRespondPermission,
  onAnswerAsk,
}: Pick<MessageListProps, "onRespondPermission" | "onAnswerAsk"> & {
  item: ChatItem;
}) {
  const live =
    (item.kind === "assistant" && item.streaming) ||
    (item.kind === "tool" && item.status === "running") ||
    (item.kind === "thinking" && !item.done) ||
    (item.kind === "permission" && !item.responded) ||
    (item.kind === "askUser" && !item.answered);
  const content = (() => {
    switch (item.kind) {
      case "user":
        return <UserMessage key={item.id} content={item.content} />;
      case "assistant":
        return (
          <AssistantMessage
            key={item.id}
            content={item.content}
            streaming={item.streaming}
          />
        );
      case "system":
        return (
          <SystemMessage
            key={item.id}
            content={item.content}
            markdown={item.markdown}
          />
        );
      case "error":
        return <ErrorMessage key={item.id} content={item.content} />;
      case "thinking":
        return (
          <div className="px-3 sm:px-5">
            <ThinkingBlock
              key={item.id}
              text={item.content}
              label={item.done ? "Thought" : "Thinking…"}
              streaming={!item.done}
            />
          </div>
        );
      case "tool":
        return <ToolBlock key={item.id} item={item} />;
      case "permission":
        return (
          <PermissionDialog
            key={item.id}
            item={item}
            onRespond={onRespondPermission}
          />
        );
      case "askUser":
        return (
          <AskUserDialog key={item.id} item={item} onAnswer={onAnswerAsk} />
        );
      case "review":
        return <ReviewProgress key={item.id} item={item} />;
      case "done":
        return <DoneIndicator key={item.id} elapsed={item.elapsed} />;
      default:
        return null;
    }
  })();
  return (
    <article className={live ? "" : "transcript-entry"}>{content}</article>
  );
});
