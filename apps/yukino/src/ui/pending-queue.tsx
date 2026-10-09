import { Box, Text } from "ink";

import { plainTerminalLine } from "./terminal-text.js";
import {
  useAvailableRows,
  useTerminalDimensions,
} from "./use-terminal-layout.js";

import { THEME } from "@/ui/styles.js";

interface PendingQueueProps {
  messages: string[];
  /** Messages steered into the in-flight run; delivered at the next turn boundary. */
  steering?: string[];
}

export function PendingQueue({ messages, steering = [] }: PendingQueueProps) {
  const { columns, rows } = useTerminalDimensions();
  const availableRows = useAvailableRows();
  const limit = Math.min(rows < 12 ? 1 : 3, Math.max(1, availableRows - 4));
  const steeringLimit = Math.min(
    steering.length,
    messages.length > 0 ? Math.ceil(limit / 2) : limit,
  );
  const followUpLimit = Math.min(messages.length, limit - steeringLimit);
  const total = messages.length + steering.length;
  if (messages.length === 0 && steering.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column" flexShrink={0} paddingX={columns > 2 ? 1 : 0}>
      {steering.slice(steering.length - steeringLimit).map((message, index) => (
        <Text
          key={`steering-${String(index)}-${message}`}
          color={THEME.dim}
          wrap="truncate-end"
        >
          {`Steering: ${plainTerminalLine(message)}`}
        </Text>
      ))}
      {messages.slice(messages.length - followUpLimit).map((message, index) => (
        <Text
          key={`${String(index)}-${message}`}
          color={THEME.dim}
          wrap="truncate-end"
        >
          Follow-up: {plainTerminalLine(message)}
        </Text>
      ))}
      {total > limit && (
        <Text color={THEME.dim} wrap="truncate-end">
          {total} queued messages
        </Text>
      )}
      <Text color={THEME.dim} wrap="truncate-end">
        {columns >= 100
          ? "Steering injects at the next turn boundary · Follow-up waits until the agent finishes · ↑ on empty input edits the latest"
          : "↑ on empty input edits the latest queued message"}
      </Text>
    </Box>
  );
}
