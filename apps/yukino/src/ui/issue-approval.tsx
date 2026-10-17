import { Box, Text, useInput } from "ink";
import type { DOMElement } from "ink";
import { useRef, useState } from "react";

import { SelectorFrame } from "./selector-frame.js";
import { ICONS, THEME } from "./styles.js";
import { TextField } from "./text-field.js";

import type { IssueDraft } from "@/feedback/types.js";

export type IssueApprovalChoice = "approve" | "reject";

interface IssueApprovalDialogProps {
  issues: IssueDraft[];
  onSelect: (choice: IssueApprovalChoice, reason?: string) => void;
}

/** First meaningful line of the body, markdown headings stripped. */
function bodyPreview(body: string): string {
  const line = body
    .split("\n")
    .map((l) =>
      l
        .replace(/^#+\s*/, "")
        .replace(/^\s*/, "")
        .trimEnd(),
    )
    .find((l) => l.length > 0);
  return line ?? "(no body)";
}

export function IssueApprovalDialog({
  issues,
  onSelect,
}: IssueApprovalDialogProps) {
  const [cursor, setCursor] = useState(0);
  const [reasonMode, setReasonMode] = useState(false);
  const [reasonText, setReasonText] = useState("");
  const [reasonError, setReasonError] = useState(false);
  const focusRef = useRef<DOMElement>(null);

  const submitReason = (value: string): void => {
    if (value.trim()) {
      onSelect("reject", value.trim());
    } else {
      setReasonError(true);
    }
  };

  useInput(
    (_input, key) => {
      if (key.upArrow && cursor > 0) {
        setCursor(cursor - 1);
      } else if (key.downArrow && cursor < 1) {
        setCursor(cursor + 1);
      } else if (key.return) {
        if (cursor === 0) {
          onSelect("approve");
        } else {
          setReasonMode(true);
        }
      } else if (key.escape) {
        // Safe default: nothing is ever filed without explicit approval.
        onSelect("reject");
      }
    },
    { isActive: !reasonMode },
  );

  const count = String(issues.length);
  const labels = [`Yes, file ${count} issue(s)`, "No, tell Yukino why not"];
  return (
    <SelectorFrame
      focusRef={focusRef}
      hint={
        reasonMode
          ? "Enter send reason · Esc reject without a reason"
          : "↑↓ navigate · Enter select · Esc reject"
      }
      subtitle={`Yukino analyzed this session and prepared ${count} issue(s) for hangtiancheng/yukino-code.`}
      title="File these issues?"
    >
      {issues.map((issue) => (
        <Box
          key={issue.title}
          flexDirection="column"
          paddingLeft={1}
          paddingRight={1}
          width="100%"
        >
          <Text color={THEME.text} wrap="truncate-end">
            {`• ${issue.title}`}
          </Text>
          <Text color={THEME.dim} wrap="truncate-end">
            {bodyPreview(issue.body)}
          </Text>
        </Box>
      ))}
      <Box flexDirection="column" marginTop={1} width="100%">
        {labels.map((label, index) => {
          const selected = index === cursor && !reasonMode;
          return (
            <Box
              key={label}
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
                {label}
              </Text>
            </Box>
          );
        })}
      </Box>
      {reasonMode ? (
        <Box ref={focusRef} flexDirection="column" paddingLeft={1}>
          <TextField
            initialValue={reasonText}
            indent={0}
            prompt="→ "
            onChange={(value) => {
              setReasonText(value);
              if (value.trim()) {
                setReasonError(false);
              }
            }}
            onSubmit={submitReason}
            onEscape={() => {
              onSelect("reject");
            }}
            onBoundary={(direction) => {
              if (direction === -1) {
                setReasonMode(false);
                setCursor(1);
              }
            }}
            onTab={(value, shift) => {
              if (shift) {
                submitReason(value);
              }
            }}
          />
          {reasonError ? (
            <Text color={THEME.error}>
              Reason is required (Esc rejects without one).
            </Text>
          ) : null}
        </Box>
      ) : null}
    </SelectorFrame>
  );
}
