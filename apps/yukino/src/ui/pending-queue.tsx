import { Box, Text } from "ink";

import { THEME } from "@/ui/styles.js";

interface PendingQueueProps {
  messages: string[];
  /** Messages steered into the in-flight run; delivered at the next turn boundary. */
  steering?: string[];
}

export function PendingQueue({ messages, steering = [] }: PendingQueueProps) {
  if (messages.length === 0 && steering.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={1} paddingRight={1}>
      {steering.map((message, index) => (
        <Text
          key={`steering-${String(index)}-${message}`}
          color={THEME.dim}
          wrap="truncate-end"
        >
          {`Steering: ${message.replaceAll("\n", " ")}`}
        </Text>
      ))}
      {messages.map((message, index) => (
        <Text
          key={`${String(index)}-${message}`}
          color={THEME.dim}
          wrap="truncate-end"
        >
          Follow-up: {message.replaceAll("\n", " ")}
        </Text>
      ))}
      <Text color={THEME.dim}>
        Steering injects at the next turn boundary · Follow-up waits until the
        agent finishes · ↑ on empty input edits the latest
      </Text>
    </Box>
  );
}
