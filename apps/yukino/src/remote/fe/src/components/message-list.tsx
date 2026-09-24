/**
 * Copyright (c) 2026 hangtiancheng
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { useAutoScroll } from "@fe/hooks/use-auto-scroll";
import type { ChatItem } from "@fe/types";

import { AskUserDialog } from "./ask-user-dialog";
import { AssistantMessage } from "./assistant-message";
import { DoneIndicator } from "./done-indicator";
import { ErrorMessage } from "./error-message";
import { PermissionDialog } from "./permission-dialog";
import { SystemMessage } from "./system-message";
import { ThinkingBlock } from "./thinking-block";
import { ToolBlock } from "./tool-block";
import { UserMessage } from "./user-message";

interface MessageListProps {
  items: ChatItem[];
  onRespondPermission: (
    id: string,
    response: "allow" | "deny" | "allowAlways",
  ) => void;
  onAnswerAsk: (id: string, answers: Record<string, string>) => void;
}

export function MessageList({
  items,
  onRespondPermission,
  onAnswerAsk,
}: MessageListProps) {
  const { ref } = useAutoScroll<HTMLDivElement>(items);

  return (
    <div
      ref={ref}
      role="log"
      aria-live="polite"
      className="flex-1 overflow-y-auto"
    >
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
            case "done":
              return <DoneIndicator key={item.id} elapsed={item.elapsed} />;
            default:
              return null;
          }
        })}
      </div>
    </div>
  );
}
