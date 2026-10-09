import { Box, Text } from "ink";
import React, { useRef } from "react";

import { renderMarkdown, renderStreamingMarkdown } from "./markdown.js";
import {
  plainTerminalLine,
  plainTerminalText,
  truncateToWidth,
  wrapToLines,
} from "./terminal-text.js";
import { ThinkingBlock } from "./thinking-block.js";
import { ToolCard, type ToolCardStatus } from "./tool-display.js";
import { useTerminalDimensions } from "./use-terminal-layout.js";

import { parseSkillPrompt } from "@/skills/executor.js";
import { THEME } from "@/ui/styles.js";

export interface ToolSummaryItem {
  toolName: string;
  argsSummary: string;
  output: string;
  isError: boolean;
  elapsed: number;
  /**
   * Explicit card status for committed Agent calls. Subagent runs are
   * committed to history as plain summaries, so without this an interrupted
   * run would render as a green success card.
   */
  status?: ToolCardStatus;
  /** Progress line (e.g. "explore subagent | 3 turns"), matching live Agent cards. */
  progress?: string;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system" | "turn_summary";
  content: string;
  /** Render a system message's content as markdown (e.g. the /help table). */
  markdown?: boolean;
  // turn_summary fields
  thinkingDuration?: number;
  toolSummary?: ToolSummaryItem[];
}

interface ChatViewProps {
  streamingText?: string;
  thinkingText?: string;
  expanded?: boolean;
}

function StreamingText({ text }: { text: string }) {
  const cache = useRef({ prefix: "", rendered: "", width: 0, theme: "" });
  const { columns } = useTerminalDimensions();
  const width = columns - (columns > 2 ? 2 : 0);
  const rendered = renderStreamingMarkdown(text, width, cache.current);
  const lines = wrapToLines(rendered, width);
  return (
    <Text>{lines.map((line) => truncateToWidth(line, width)).join("\n")}</Text>
  );
}

export const ChatView = React.memo(function (props: ChatViewProps) {
  const { streamingText, thinkingText, expanded = false } = props;
  const { columns } = useTerminalDimensions();
  const padding = columns > 2 ? 1 : 0;
  return (
    <Box flexDirection="column">
      {thinkingText ? (
        <ThinkingBlock text={thinkingText} expanded={expanded} streaming />
      ) : null}
      {streamingText !== undefined && streamingText !== "" && (
        <Box marginTop={1} paddingX={padding}>
          <StreamingText text={streamingText} />
        </Box>
      )}
    </Box>
  );
});

interface CommitMessageProps {
  message: ChatMessage;
  expanded?: boolean | undefined;
}

export const CommittedMessage = React.memo(function CommittedMessage(
  props: CommitMessageProps,
) {
  const { message, expanded = false } = props;
  return <MessageBlock message={message} expanded={expanded} />;
});

interface TurnSummaryBlockProps {
  message: ChatMessage;
  expanded: boolean;
}

function TurnSummaryBlock({ message, expanded }: TurnSummaryBlockProps) {
  const { content, thinkingDuration, toolSummary = [] } = message;
  return (
    <Box flexDirection="column">
      <ThinkingBlock
        text={content}
        duration={thinkingDuration}
        expanded={expanded}
      />
      {toolSummary.map((tool, index) => (
        <ToolCard key={index} {...tool} expanded={expanded} />
      ))}
    </Box>
  );
}

interface MessageBlockProps {
  message: ChatMessage;
  expanded: boolean;
}

function MessageBlock(props: MessageBlockProps) {
  const { message, expanded } = props;
  const { columns: width } = useTerminalDimensions();
  const padding = width > 2 ? 1 : 0;
  const contentWidth = width - padding * 2;

  switch (message.role) {
    case "user": {
      const skill = parseSkillPrompt(message.content);
      const text = skill ? skill.args : message.content;
      return (
        <Box flexDirection="column">
          {skill && (
            <Box
              backgroundColor={THEME.customMessageBg}
              flexDirection="column"
              marginTop={1}
              paddingX={padding}
              paddingY={1}
              width={width}
            >
              <Text color={THEME.customMessageText}>
                <Text bold color={THEME.customMessageLabel}>
                  [skill]
                </Text>{" "}
                {plainTerminalLine(skill.name)}{" "}
                <Text color={THEME.muted}>
                  (Ctrl+O to {expanded ? "collapse" : "expand"})
                </Text>
              </Text>
              {expanded && (
                <>
                  <Text color={THEME.muted}>
                    {plainTerminalText(skill.directory)}
                  </Text>
                  <Text color={THEME.customMessageText}>
                    {renderMarkdown(skill.body, contentWidth, "user")}
                  </Text>
                </>
              )}
            </Box>
          )}
          {(!skill || text.length > 0) && (
            <Box
              backgroundColor={THEME.userMessageBg}
              marginTop={1}
              paddingX={padding}
              paddingY={1}
              width={width}
            >
              <Text color={THEME.userMessageText}>
                {skill
                  ? plainTerminalText(text)
                  : renderMarkdown(text, contentWidth, "user")}
              </Text>
            </Box>
          )}
        </Box>
      );
    }

    case "assistant": {
      return (
        <Box marginTop={1} paddingX={padding}>
          <Text>{renderMarkdown(message.content, contentWidth)}</Text>
        </Box>
      );
    }

    case "turn_summary": {
      return <TurnSummaryBlock message={message} expanded={expanded} />;
    }

    case "system": {
      if (message.markdown) {
        return (
          <Box marginTop={1} paddingX={padding}>
            <Text>{renderMarkdown(message.content, contentWidth)}</Text>
          </Box>
        );
      }
      const isError = /^(?:Error:|Hook error:)/u.test(message.content);
      const isWarning = /^(?:Warning:|Hook warning:|↻)/u.test(message.content);
      const isCompaction = /^(?:⊙ |Compact:)/u.test(message.content);
      if (isCompaction) {
        return (
          <Box
            backgroundColor={THEME.customMessageBg}
            flexDirection="column"
            marginTop={1}
            paddingX={padding}
            paddingY={1}
            width={width}
          >
            <Text bold color={THEME.customMessageLabel}>
              [compaction]
            </Text>
            <Text color={THEME.customMessageText}>
              {plainTerminalText(
                message.content.replace(/^(?:⊙ |Compact:\s*)/u, ""),
              )}
            </Text>
          </Box>
        );
      }
      return (
        <Box marginTop={1} paddingX={padding}>
          <Text
            color={
              isError ? THEME.error : isWarning ? THEME.warning : THEME.muted
            }
          >
            {plainTerminalText(message.content.replace(/^↻\s*/u, "Retrying: "))}
          </Text>
        </Box>
      );
    }
    default: {
      return null;
    }
  }
}
