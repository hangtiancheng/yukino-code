import { Box, Text } from "ink";

import { THEME } from "@/ui/styles.js";

/**
 * Renders the line-numbered diff text produced by buildDiff() as colored lines:
 * lines starting with "+ " are green, "- " are red, others (context/summary lines) are dimmed.
 */
export function DiffLines({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        if (line.startsWith("+ ")) {
          return (
            <Text key={i} color={THEME.toolDiffAdded}>
              {line}
            </Text>
          );
        }
        if (line.startsWith("- ")) {
          return (
            <Text key={i} color={THEME.toolDiffRemoved}>
              {line}
            </Text>
          );
        }
        return (
          <Text key={i} color={THEME.toolDiffContext}>
            {line}
          </Text>
        );
      })}
    </Box>
  );
}
