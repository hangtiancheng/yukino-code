import { Markdown } from "#/components/markdown.js";
import { StreamingCursor } from "#/components/streaming-cursor.js";
import { ThinkingBlock } from "#/components/thinking-block.js";
import { isOpenThinking, splitThinking, stripThinkOpen } from "#/lib/format.js";

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
