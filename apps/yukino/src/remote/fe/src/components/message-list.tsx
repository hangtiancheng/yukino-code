import { useAutoScroll } from "@fe/hooks/use-auto-scroll";
import type { ChatItem } from "@fe/types";

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
  const ref = useAutoScroll<HTMLDivElement>(items);

  return (
    <div
      ref={ref}
      role="log"
      aria-live="polite"
      className="flex-1 overflow-y-auto"
    >
      {items.length === 0 ? (
        <div className="mx-auto h-full w-full max-w-3xl px-5 py-6">
          <Welcome {...welcome} />
        </div>
      ) : (
        <div className="mx-auto w-full max-w-3xl px-5 py-6">
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
                return <SystemMessage key={item.id} content={item.content} />;
              case "error":
                return <ErrorMessage key={item.id} content={item.content} />;
              case "thinking":
                return (
                  <ThinkingBlock
                    key={item.id}
                    text={item.content}
                    label={item.done ? "✻ Thought" : "✻ Thinking..."}
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
  );
}
