import { Box, Text, useInput } from "ink";
import type { DOMElement } from "ink";
import { useRef, useState } from "react";

import { SelectorFrame } from "./selector-frame.js";
import { TextField } from "./text-field.js";

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
  const focusRef = useRef<DOMElement>(null);
  const [feedbackText, setFeedbackText] = useState("");
  const [feedbackError, setFeedbackError] = useState(false);
  const submitFeedback = (value: string) => {
    if (value.trim()) {
      onSelect("feedback", value);
    } else {
      setFeedbackError(true);
    }
  };

  useInput(
    (_input, key) => {
      if (cursor === 2) {
        return;
      }
      if (key.upArrow && cursor > 0) {
        setCursor(cursor - 1);
      } else if (key.downArrow && cursor < PLAN_APPROVAL_OPTIONS.length - 1) {
        setCursor(cursor + 1);
      } else if (key.return) {
        if (cursor === 0) {
          onSelect("yolo");
        } else if (cursor === 1) {
          onSelect("manual");
        }
      } else if (key.escape) {
        // Escape defaults to the middle ground: approve the plan, but keep
        // confirming every edit. It does not cancel the approval.
        onSelect("manual");
      }
    },
    { isActive: cursor !== 2 },
  );

  return (
    <SelectorFrame
      focusRef={focusRef}
      hint="↑↓ navigate · Enter select · Shift+Tab submit feedback · Esc approve with manual confirmation"
      subtitle="Yukino has written a plan and is ready to execute."
      title="Plan complete"
    >
      {PLAN_APPROVAL_OPTIONS.map((label, index) => {
        const selected = index === cursor;
        return (
          <Box
            key={label}
            ref={selected && cursor !== 2 ? focusRef : undefined}
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
              {label}
            </Text>
          </Box>
        );
      })}
      {cursor === 2 ? (
        <Box ref={focusRef} flexDirection="column" paddingLeft={1}>
          <TextField
            initialValue={feedbackText}
            indent={0}
            onChange={(value) => {
              setFeedbackText(value);
              if (value.trim()) {
                setFeedbackError(false);
              }
            }}
            onSubmit={submitFeedback}
            onEscape={() => {
              onSelect("manual");
            }}
            onBoundary={(direction) => {
              if (direction === -1) {
                setCursor(1);
              }
            }}
            onTab={(value, shift) => {
              if (shift) {
                submitFeedback(value);
              }
            }}
          />
          {feedbackError ? (
            <Text color={THEME.error}>Feedback is required.</Text>
          ) : null}
        </Box>
      ) : null}
    </SelectorFrame>
  );
}
