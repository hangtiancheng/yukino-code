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

import { Box, Text, useStdout } from "ink";
import React, { useRef } from "react";

import { renderMarkdown, renderStreamingMarkdown } from "./markdown.js";
import { wrapToLines } from "./terminal-text.js";
import { ThinkingBlock } from "./thinking-block.js";
import { ToolCard, type ToolCardStatus } from "./tool-display.js";

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
  // turn_summary fields
  thinkingDuration?: number;
  toolSummary?: ToolSummaryItem[];
}

interface ChatViewProps {
  messages: ChatMessage[];
  streamingText?: string;
  thinkingText?: string;
  expanded?: boolean;
}

function StreamingText({ text }: { text: string }) {
  const cache = useRef({ prefix: "", rendered: "", width: 0, theme: "" });
  const { stdout } = useStdout();
  const width = Math.max(1, (stdout.columns || 80) - 2);
  const rendered = renderStreamingMarkdown(text, width, cache.current);
  const lines = wrapToLines(rendered, width);
  const limit = Math.max(2, (stdout.rows || 24) - 12);
  const visible =
    lines.length > limit ? ["…", ...lines.slice(-(limit - 1))] : lines;
  return <Text>{visible.join("\n")}</Text>;
}

export const ChatView = React.memo(function (props: ChatViewProps) {
  const { messages, streamingText, thinkingText, expanded = false } = props;
  return (
    <Box flexDirection="column">
      {messages.map((msg, i) => (
        <MessageBlock key={i} message={msg} expanded={expanded} />
      ))}
      {thinkingText ? (
        <ThinkingBlock text={thinkingText} expanded={expanded} streaming />
      ) : null}
      {streamingText !== undefined && streamingText !== "" && (
        <Box marginTop={1} paddingLeft={1}>
          <StreamingText text={streamingText} />
        </Box>
      )}
    </Box>
  );
});

/**
 * CommittedMessage renders a single finalized message for use inside Ink's
 * <Static> component. Once rendered, Static never re-renders it, eliminating
 * flicker from the scrollback history.
 */

interface CommitMessageProps {
  message: ChatMessage;
  expanded?: boolean | undefined;
}
export function CommittedMessage(props: CommitMessageProps) {
  const { message, expanded = false } = props;
  return <MessageBlock message={message} expanded={expanded} />;
}

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
  const { stdout } = useStdout();
  const width = Math.max(1, stdout.columns || 80);

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
              paddingX={1}
              paddingY={1}
              width={width}
            >
              <Text color={THEME.customMessageText}>
                <Text bold color={THEME.customMessageLabel}>
                  [skill]
                </Text>{" "}
                {skill.name}{" "}
                <Text color={THEME.muted}>
                  (Ctrl+O to {expanded ? "collapse" : "expand"})
                </Text>
              </Text>
              {expanded && (
                <>
                  <Text color={THEME.muted}>{skill.directory}</Text>
                  <Text color={THEME.customMessageText}>
                    {renderMarkdown(skill.body, Math.max(1, width - 2), "user")}
                  </Text>
                </>
              )}
            </Box>
          )}
          {(!skill || text.length > 0) && (
            <Box
              backgroundColor={THEME.userMessageBg}
              marginTop={1}
              paddingLeft={1}
              paddingRight={1}
              paddingY={1}
              width={width}
            >
              <Text color={THEME.userMessageText}>
                {skill
                  ? text
                  : renderMarkdown(text, Math.max(1, width - 2), "user")}
              </Text>
            </Box>
          )}
        </Box>
      );
    }

    case "assistant": {
      return (
        <Box marginTop={1} paddingLeft={1} paddingRight={1}>
          <Text>{renderMarkdown(message.content, Math.max(1, width - 2))}</Text>
        </Box>
      );
    }

    case "turn_summary": {
      return <TurnSummaryBlock message={message} expanded={expanded} />;
    }

    case "system": {
      const isError = /^(?:Error:|Hook error:)/u.test(message.content);
      const isWarning = /^(?:Warning:|Hook warning:|↻)/u.test(message.content);
      const isCompaction = /^(?:⊙ |Compact:)/u.test(message.content);
      if (isCompaction) {
        return (
          <Box
            backgroundColor={THEME.customMessageBg}
            flexDirection="column"
            marginTop={1}
            paddingLeft={1}
            paddingRight={1}
            paddingY={1}
            width={width}
          >
            <Text bold color={THEME.customMessageLabel}>
              [compaction]
            </Text>
            <Text color={THEME.customMessageText}>
              {message.content.replace(/^(?:⊙ |Compact:\s*)/u, "")}
            </Text>
          </Box>
        );
      }
      return (
        <Box marginTop={1} paddingLeft={1} paddingRight={1}>
          <Text
            color={
              isError ? THEME.error : isWarning ? THEME.warning : THEME.muted
            }
          >
            {message.content.replace(/^↻\s*/u, "Retrying: ")}
          </Text>
        </Box>
      );
    }
    default: {
      return null;
    }
  }
}
