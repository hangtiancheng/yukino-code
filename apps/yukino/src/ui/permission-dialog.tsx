import { Box, Text, useInput } from "ink";
import type { DOMElement } from "ink";
import { useRef, useState } from "react";

import { SelectorFrame } from "./selector-frame.js";
import { truncateToWidth } from "./terminal-text.js";

import { ICONS, THEME } from "@/ui/styles.js";

export type PermissionAction = "allow" | "deny" | "allowAlways";

const PERMISSION_OPTIONS: { label: string; action: PermissionAction }[] = [
  { label: "Yes", action: "allow" },
  {
    label: "Yes, allow this pattern for all agents in this project",
    action: "allowAlways",
  },
  { label: "No", action: "deny" },
];

interface PermissionDialogProps {
  agentName?: string;
  cwd?: string;
  requestId?: string;
  toolName: string;
  argsSummary: string;
  reason: string;
  onComplete: (action: PermissionAction) => void;
}

export function PermissionDialog({
  agentName = "main",
  cwd,
  toolName,
  argsSummary,
  reason,
  onComplete,
}: PermissionDialogProps) {
  const [cursor, setCursor] = useState(0);
  const focusRef = useRef<DOMElement>(null);

  useInput((_input, key) => {
    if (key.upArrow) {
      setCursor((current) =>
        current > 0 ? current - 1 : PERMISSION_OPTIONS.length - 1,
      );
    } else if (key.downArrow) {
      setCursor((current) =>
        current < PERMISSION_OPTIONS.length - 1 ? current + 1 : 0,
      );
    } else if (key.return) {
      const option = PERMISSION_OPTIONS[cursor];
      if (option) {
        onComplete(option.action);
      }
    } else if (key.escape) {
      onComplete("deny");
    }
  });

  const detail = [cwd, argsSummary, reason].filter(Boolean).join(" · ");
  return (
    <SelectorFrame
      focusRef={focusRef}
      hint="↑↓ navigate · Enter select · Escape deny"
      subtitle={truncateToWidth(detail, 160)}
      title={`${agentName}: ${toolName} requires approval`}
    >
      {PERMISSION_OPTIONS.map((option, index) => {
        const selected = index === cursor;
        return (
          <Box
            key={option.action}
            ref={selected ? focusRef : undefined}
            backgroundColor={selected ? THEME.selectedBg : undefined}
            paddingLeft={1}
            paddingRight={1}
            width="100%"
          >
            <Text
              color={selected ? THEME.accent : THEME.muted}
              wrap="truncate-end"
            >
              {selected ? `${ICONS.arrow} ` : "  "}
              {option.label}
            </Text>
          </Box>
        );
      })}
    </SelectorFrame>
  );
}
