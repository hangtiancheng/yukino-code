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

export type PermissionAction = "allow" | "deny" | "allowAlways";

const PERMISSION_OPTIONS: { label: string; action: PermissionAction }[] = [
  { label: "Yes", action: "allow" },
  { label: "Yes, and don't ask again for this pattern", action: "allowAlways" },
  { label: "No", action: "deny" },
];

interface PermissionDialogProps {
  toolName: string;
  argsSummary: string;
  reason: string;
  onComplete: (action: PermissionAction) => void;
}

export function PermissionDialog({
  toolName,
  argsSummary,
  reason,
  onComplete,
}: PermissionDialogProps) {
  const [cursor, setCursor] = useState(0);

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

  const detail = [argsSummary, reason].filter(Boolean).join(" · ");
  return (
    <SelectorFrame
      hint="↑↓ navigate · Enter select · Escape deny"
      subtitle={detail.length > 160 ? `${detail.slice(0, 160)}…` : detail}
      title={`${toolName} requires approval`}
    >
      {PERMISSION_OPTIONS.map((option, index) => {
        const selected = index === cursor;
        return (
          <Box
            key={option.action}
            backgroundColor={selected ? THEME.selectedBg : undefined}
            paddingLeft={1}
            paddingRight={1}
            width="100%"
          >
            <Text color={selected ? THEME.accent : THEME.muted}>
              {selected ? `${ICONS.arrow} ` : "  "}
              {option.label}
            </Text>
          </Box>
        );
      })}
    </SelectorFrame>
  );
}
