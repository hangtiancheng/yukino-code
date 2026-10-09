import {
  isOpenThinking,
  splitThinking,
  stripThinkOpen,
} from "@browser/lib/format";
import { renderMarkdown } from "@browser/lib/markdown";

import { StreamingCursor } from "./streaming-cursor";
import { ThinkingBlock } from "./thinking-block";

interface AssistantMessageProps {
  content: string;
  streaming: boolean;
}

export function AssistantMessage({
  content,
  streaming,
}: AssistantMessageProps) {
  const { thinking, body } = splitThinking(content);
  const showOpenThinking = streaming && isOpenThinking(content);

  let bodyHtml = "";
  if (showOpenThinking) {
    // While <think ...> is open, the visible body is empty.
  } else if (thinking) {
    bodyHtml = renderMarkdown(body);
  } else {
    bodyHtml = renderMarkdown(content);
  }

  return (
    <div className="mb-5 leading-relaxed">
      {thinking && <ThinkingBlock text={thinking} label="Thought" />}
      {showOpenThinking && (
        <ThinkingBlock
          text={stripThinkOpen(content)}
          label="Thinking…"
          streaming
        />
      )}
      {bodyHtml && (
        <div
          className="mt-1 text-sm [&_a]:text-accent [&_a]:underline [&_a]:underline-offset-2 [&_blockquote]:border-l-2 [&_blockquote]:border-accent-dim/50 [&_blockquote]:pl-3 [&_blockquote]:text-dim [&_code]:rounded [&_code]:bg-code [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[13px] [&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:font-semibold [&_h2]:text-bright [&_h3]:mt-3 [&_h3]:mb-1.5 [&_h3]:font-semibold [&_h3]:text-bright [&_li]:my-1 [&_ol]:my-2 [&_ol]:pl-5 [&_p]:mb-2 [&_pre]:my-2.5 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-border [&_pre]:bg-code [&_pre]:p-3.5 [&_pre_code]:bg-none [&_pre_code]:p-0 [&_table]:my-2.5 [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-1.5 [&_th]:border [&_th]:border-border [&_th]:bg-tool [&_th]:px-3 [&_th]:py-1.5 [&_th]:font-semibold [&_th]:text-bright [&_ul]:my-2 [&_ul]:pl-5"
          dangerouslySetInnerHTML={{ __html: bodyHtml }}
        />
      )}
      {streaming && <StreamingCursor />}
    </div>
  );
}
