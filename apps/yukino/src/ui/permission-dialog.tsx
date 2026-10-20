import { Box, Text, useInput } from "ink";
import type { DOMElement } from "ink";
import { useRef, useState } from "react";

import { ICONS, THEME } from "@/ui/constants.js";
import { SelectorFrame } from "@/ui/selector-frame.js";
import { truncateToWidth } from "@/ui/terminal-text.js";


export type PermissionAction = "allow" | "deny" | "allowAlways";

const PERMISSION_OPTIONS: { label: string; action: PermissionAction }[] = [
  { label: "Yes", action: "allow" },
  {
    label: "Yes, remember the scopes above for all agents in this project",
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
  rememberPatterns?: string[];
  onComplete: (action: PermissionAction) => void;
}

export function PermissionDialog({
  agentName = "main",
  cwd,
  toolName,
  argsSummary,
  reason,
  rememberPatterns = [],
  onComplete,
}: PermissionDialogProps) {
  const options = PERMISSION_OPTIONS.filter(
    (option) => option.action !== "allowAlways" || rememberPatterns.length > 0,
  );
  const [cursor, setCursor] = useState(0);
  const focusRef = useRef<DOMElement>(null);

  useInput((_input, key) => {
    if (key.upArrow) {
      setCursor((current) => (current > 0 ? current - 1 : options.length - 1));
    } else if (key.downArrow) {
      setCursor((current) => (current < options.length - 1 ? current + 1 : 0));
    } else if (key.return) {
      const option = options[cursor];
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
      {rememberPatterns.map((pattern) => (
        <Text key={pattern} wrap="wrap">
          Remember scope: {pattern}
        </Text>
      ))}
      {options.map((option, index) => {
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
