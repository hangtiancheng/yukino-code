import { Box, Text } from "ink";

import { THEME } from "./styles.js";

export function UpdateNotice({ latestVersion }: { latestVersion?: string }) {
  if (!latestVersion) {
    return null;
  }
  return (
    <Box paddingLeft={1}>
      <Text color={THEME.warning}>
        New Yukino version v{latestVersion} is available. Run{" "}
        <Text bold color={THEME.accent}>
          yukino update
        </Text>
      </Text>
    </Box>
  );
}
