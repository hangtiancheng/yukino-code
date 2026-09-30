import { Box, Text } from "ink";

import { THEME } from "@/ui/styles.js";

interface TeamStatusProps {
  count: number;
}

export function TeamStatus({ count }: TeamStatusProps) {
  if (count === 0) {
    return null;
  }

  return (
    <Box paddingLeft={1}>
      <Text color={THEME.dim}>
        • {count} {count === 1 ? "teammate" : "teammates"}
      </Text>
    </Box>
  );
}
