import { Box, Text } from "ink";

import { THEME } from "@/ui/styles.js";

interface AgentStatusProps {
  teammates: number;
  backgroundSubagents: number;
}

export function AgentStatus({
  teammates,
  backgroundSubagents,
}: AgentStatusProps) {
  const counts = [
    ...(teammates
      ? [`${String(teammates)} ${teammates === 1 ? "teammate" : "teammates"}`]
      : []),
    ...(backgroundSubagents
      ? [
          `${String(backgroundSubagents)} background ${backgroundSubagents === 1 ? "subagent" : "subagents"}`,
        ]
      : []),
  ];
  if (counts.length === 0) {
    return null;
  }

  return (
    <Box paddingLeft={1}>
      <Text color={THEME.dim} wrap="truncate-end">
        • {counts.join(" · ")} · ↓ on last input line to view
      </Text>
    </Box>
  );
}
