import { Box, Text, useInput, usePaste } from "ink";
import { useState } from "react";

import { SelectorFrame } from "./selector-frame.js";

import { ICONS, THEME } from "@/ui/styles.js";

export type PlanChoice = "yolo" | "manual" | "feedback";

interface PlanApprovalDialogProps {
  onSelect: (choice: PlanChoice, feedback?: string) => void;
}

const PLAN_APPROVAL_OPTIONS = [
  "Yes, enter YOLO mode (auto-approve all)",
  "Yes, manually approve edits",
  "Tell Yukino what to change",
];

export function PlanApprovalDialog({ onSelect }: PlanApprovalDialogProps) {
  const [cursor, setCursor] = useState(0);
  const [feedbackText, setFeedbackText] = useState("");
  const [feedbackError, setFeedbackError] = useState(false);

  useInput((input, key) => {
    if (key.upArrow && cursor > 0) {
      setCursor(cursor - 1);
    } else if (key.downArrow && cursor < PLAN_APPROVAL_OPTIONS.length - 1) {
      setCursor(cursor + 1);
    } else if (key.return) {
      if (cursor === 0) {
        onSelect("yolo");
      } else if (cursor === 1) {
        onSelect("manual");
      } else if (feedbackText) {
        onSelect("feedback", feedbackText);
      } else {
        setFeedbackError(true);
      }
    } else if (key.escape) {
      // Escape defaults to the middle ground: approve the plan, but keep
      // confirming every edit. It does not cancel the approval.
      onSelect("manual");
    } else if (key.tab && key.shift && cursor === 2 && feedbackText) {
      onSelect("feedback", feedbackText);
    } else if (cursor === 2 && key.backspace) {
      setFeedbackText((current) => current.slice(0, -1));
    } else if (cursor === 2 && input && !key.ctrl && !key.meta) {
      setFeedbackError(false);
      setFeedbackText((current) => current + input);
    }
  });

  // Pasted text (bracketed paste) arrives as one chunk, not per-key input.
  usePaste((text) => {
    if (cursor === 2 && text) {
      setFeedbackError(false);
      setFeedbackText((current) => current + text);
    }
  });

  return (
    <SelectorFrame
      hint="↑↓ navigate · Enter select · Shift+Tab submit feedback · Esc approve with manual confirmation"
      subtitle="Yukino has written a plan and is ready to execute."
      title="Plan complete"
    >
      {PLAN_APPROVAL_OPTIONS.map((label, index) => {
        const selected = index === cursor;
        return (
          <Box
            key={label}
            backgroundColor={selected ? THEME.selectedBg : undefined}
            paddingLeft={1}
            paddingRight={1}
            width="100%"
          >
            <Text color={selected ? THEME.accent : THEME.muted}>
              {selected ? `${ICONS.arrow} ` : "  "}
              {label}
            </Text>
          </Box>
        );
      })}
      {cursor === 2 ? (
        <Box flexDirection="column" paddingLeft={3} paddingY={1}>
          <Text color={THEME.text}>
            {feedbackText || (
              <Text color={THEME.dim}>Type feedback here...</Text>
            )}
            <Text inverse> </Text>
          </Text>
          {feedbackError ? (
            <Text color={THEME.error}>Feedback is required.</Text>
          ) : null}
        </Box>
      ) : null}
    </SelectorFrame>
  );
}
