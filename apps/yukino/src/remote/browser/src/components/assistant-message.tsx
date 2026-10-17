import {
  isOpenThinking,
  splitThinking,
  stripThinkOpen,
} from "@browser/lib/format";

import { Markdown } from "./markdown";
import { StreamingCursor } from "./streaming-cursor";
import { ThinkingBlock } from "./thinking-block";

export function AssistantMessage({
  content,
  streaming,
}: {
  content: string;
  streaming: boolean;
}) {
  const { thinking, body } = splitThinking(content);
  const showOpenThinking = streaming && isOpenThinking(content);
  const visibleBody = showOpenThinking ? "" : thinking ? body : content;
  return (
    <div className="my-4 px-3 sm:px-5">
      {thinking && <ThinkingBlock text={thinking} label="Thought" />}
      {showOpenThinking && (
        <ThinkingBlock
          text={stripThinkOpen(content)}
          label="Thinking…"
          streaming
        />
      )}
      {visibleBody && <Markdown text={visibleBody} />}
      {streaming && <StreamingCursor />}
    </div>
  );
}
