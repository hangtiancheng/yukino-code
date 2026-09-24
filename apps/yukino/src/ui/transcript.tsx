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
}

export function Transcript({
  messages,
  sessionId,
  termWidth,
  expanded,
  model,
  workDir,
  provider,
}: Props) {
  return (
    <Static
      key={`transcript-${sessionId}-${String(termWidth)}-${String(expanded)}`}
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
              Esc interrupt · Ctrl+C clear/exit · /commands · Ctrl+O details ·
              Ctrl+T teams
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
