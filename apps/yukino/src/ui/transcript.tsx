import { Box, Static, Text, useIsScreenReaderEnabled, useStdout } from "ink";
import { memo, useInsertionEffect } from "react";

import { CommittedMessage, type ChatMessage } from "./chat.js";
import { expectStaticTerminalOutput } from "./terminal-output.js";
import { plainTerminalLine, truncateToWidth } from "./terminal-text.js";
import { useTerminalDimensions } from "./use-terminal-layout.js";

import { THEME } from "@/ui/styles.js";
import { compactPath } from "@/utils/paths.js";
import { version } from "@/version.js";

interface Props {
  messages: ChatMessage[];
  sessionId: string;
  expanded: boolean;
  model: string;
  cwd: string;
  provider: string;
  revision?: number;
}

export const Transcript = memo(function Transcript({
  messages,
  sessionId,
  expanded,
  model,
  cwd,
  provider,
  revision = 0,
}: Props) {
  const { stdout } = useStdout();
  const screenReader = useIsScreenReaderEnabled();
  const identity = `${sessionId}-${String(revision)}-${String(expanded)}`;
  useInsertionEffect(() => {
    expectStaticTerminalOutput(stdout, screenReader, identity);
  }, [stdout, screenReader, identity, messages.length]);
  const { columns: termWidth } = useTerminalDimensions();
  const padding = termWidth > 2 ? 1 : 0;
  const width = Math.max(1, termWidth - padding * 2);
  return (
    <Static key={identity} items={[null, ...messages]}>
      {(message, index) =>
        message ? (
          <CommittedMessage key={index} message={message} expanded={expanded} />
        ) : (
          <Box
            key="header"
            flexDirection="column"
            marginTop={1}
            paddingX={padding}
          >
            <Text>
              <Text bold color={THEME.accent}>
                Yukino
              </Text>
              <Text color={THEME.dim}> v{version}</Text>
            </Text>
            <Text color={THEME.muted} wrap="truncate-end">
              {truncateToWidth(
                termWidth >= 80
                  ? "Esc interrupt · /commands · Ctrl+O details"
                  : termWidth >= 40
                    ? "/help · Esc interrupt · Ctrl+O details"
                    : "/help · Esc interrupt",
                width,
              )}
            </Text>
            <Text color={THEME.dim} wrap="truncate-end">
              {truncateToWidth(
                plainTerminalLine(`${provider}/${model} · ${compactPath(cwd)}`),
                width,
              )}
            </Text>
          </Box>
        )
      }
    </Static>
  );
});
