import { useAutoScroll } from "@browser/hooks/use-auto-scroll";
import type { ChatItem } from "@browser/types";

import { AskUserDialog } from "./ask-user-dialog";
import { AssistantMessage } from "./assistant-message";
import { DoneIndicator } from "./done-indicator";
import { ErrorMessage } from "./error-message";
import { PermissionDialog } from "./permission-dialog";
import { ReviewProgress } from "./review-progress";
import { SystemMessage } from "./system-message";
import { ThinkingBlock } from "./thinking-block";
import { ToolBlock } from "./tool-block";
import { UserMessage } from "./user-message";
import { Welcome, type WelcomeInfo } from "./welcome";

interface MessageListProps {
  items: ChatItem[];
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
  welcome,
  onRespondPermission,
  onAnswerAsk,
}: MessageListProps) {
  const { ref, atBottom, scrollToBottom } =
    useAutoScroll<HTMLDivElement>(items);

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={ref}
        role="log"
        aria-live="polite"
        className="h-full overflow-y-auto overscroll-contain"
      >
        {items.length === 0 ? (
          <div className="mx-auto h-full w-full max-w-5xl px-4 py-4 sm:px-6 sm:py-6">
            <Welcome {...welcome} />
          </div>
        ) : (
          <div className="mx-auto w-full max-w-5xl px-4 py-4 sm:px-6 sm:py-6">
            {items.map((item) => {
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
                    <ThinkingBlock
                      key={item.id}
                      text={item.content}
                      label={item.done ? "Thought" : "Thinking…"}
                      streaming={!item.done}
                    />
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
                    <AskUserDialog
                      key={item.id}
                      item={item}
                      onAnswer={onAnswerAsk}
                    />
                  );
                case "review":
                  return <ReviewProgress key={item.id} item={item} />;
                case "done":
                  return <DoneIndicator key={item.id} elapsed={item.elapsed} />;
                default:
                  return null;
              }
            })}
          </div>
        )}
      </div>
      {!atBottom && items.length > 0 && (
        <button
          type="button"
          onClick={scrollToBottom}
          aria-label="Scroll to the latest message"
          title="Scroll to the latest message"
          className="absolute bottom-4 left-1/2 z-10 flex h-8 w-8 -translate-x-1/2 cursor-pointer items-center justify-center rounded-full border border-border bg-surface text-dim shadow-pop transition-colors hover:text-bright"
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
