import { Box, Static, Text } from "ink";

import { CommittedMessage, type ChatMessage } from "./chat.js";

import { THEME } from "@/ui/styles.js";
import { compactPath } from "@/utils/paths.js";
import { version } from "@/version.js";

interface Props {
  messages: ChatMessage[];
  sessionId: string;
  termWidth: number;
  expanded: boolean;
  model: string;
  workDir: string;
  provider: string;
  revision: number;
}

export function Transcript({
  messages,
  sessionId,
  termWidth,
  expanded,
  model,
  workDir,
  provider,
  revision,
}: Props) {
  return (
    <Static
      key={`transcript-${sessionId}-${String(termWidth)}-${String(expanded)}-${String(revision)}`}
      items={[
        { type: "brand" as const, key: "brand" },
        ...messages.map((message, index) => ({
          type: "message" as const,
          key: `message-${String(index)}`,
          message,
        })),
      ]}
    >
      {(item) =>
        item.type === "brand" ? (
          <Box
            key={item.key}
            flexDirection="column"
            marginBottom={1}
            marginTop={1}
            paddingLeft={1}
          >
            <Text>
              <Text bold color={THEME.accent}>
                Yukino
              </Text>
              <Text color={THEME.dim}> v{version}</Text>
            </Text>
            <Text color={THEME.muted}>
              Esc interrupt · Ctrl+C clear/exit · /commands · Ctrl+O details · ↓
              on last input line: agents
            </Text>
            <Text color={THEME.dim} wrap="truncate-end">
              {provider}/{model} · {compactPath(workDir)}
            </Text>
          </Box>
        ) : (
          <CommittedMessage
            key={item.key}
            message={item.message}
            expanded={expanded}
          />
        )
      }
    </Static>
  );
}
