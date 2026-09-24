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

import { Box, Text, useInput } from "ink";
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
      }
    } else if (key.escape) {
      onSelect("manual");
    } else if (key.tab && key.shift && cursor === 2 && feedbackText) {
      onSelect("feedback", feedbackText);
    } else if (cursor === 2 && key.backspace) {
      setFeedbackText((current) => current.slice(0, -1));
    } else if (cursor === 2 && input && !key.ctrl && !key.meta) {
      setFeedbackText((current) => current + input);
    }
  });

  return (
    <SelectorFrame
      hint="↑↓ navigate · Enter select · Escape cancel"
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
        <Box paddingLeft={3} paddingY={1}>
          <Text color={THEME.text}>
            {feedbackText || (
              <Text color={THEME.dim}>Type feedback here...</Text>
            )}
            <Text inverse> </Text>
          </Text>
        </Box>
      ) : null}
    </SelectorFrame>
  );
}
