import { attachmentSizePreview } from "@yukino.js/feedback/collect.js";
import type {
  AttachmentKind,
  FeedbackOptions,
} from "@yukino.js/feedback/types.js";
import { Box, Text, useInput } from "ink";
import type { DOMElement } from "ink";
import { useRef, useState } from "react";

import { FEEDBACK_ITEMS, THEME } from "./constants.js";
import { SelectorFrame } from "./selector-frame.js";
import { truncateToWidth } from "./terminal-text.js";
import { useTerminalDimensions } from "./use-terminal-layout.js";

interface Props {
  cwd: string;
  sessionId: string;
  /** Supplied inline as `/feedback <text>`; empty when the user gave none. */
  description: string;
  onSubmit: (options: FeedbackOptions) => void;
  onCancel: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${String(bytes)} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FeedbackDialog({
  cwd,
  sessionId,
  description,
  onSubmit,
  onCancel,
}: Props) {
  const [cursor, setCursor] = useState(0);
  const [checked, setChecked] = useState<Record<AttachmentKind, boolean>>({
    session: true,
    tools: false,
    "file-history": false,
    log: true,
    env: true,
  });
  const focusRef = useRef<DOMElement>(null);
  const submittingRef = useRef(false);
  const { columns } = useTerminalDimensions();
  // Sizes are computed once on mount; they only decorate the checklist.
  const [sizes] = useState(() =>
    FEEDBACK_ITEMS.map((item) =>
      attachmentSizePreview(cwd, sessionId, item.kind),
    ),
  );

  useInput((input, key) => {
    if (key.upArrow) {
      setCursor((current) =>
        current > 0 ? current - 1 : FEEDBACK_ITEMS.length - 1,
      );
    } else if (key.downArrow) {
      setCursor((current) =>
        current < FEEDBACK_ITEMS.length - 1 ? current + 1 : 0,
      );
    } else if (input === " ") {
      const item = FEEDBACK_ITEMS[cursor];
      if (item) {
        setChecked((prev) => ({ ...prev, [item.kind]: !prev[item.kind] }));
      }
    } else if (key.return) {
      if (submittingRef.current) {
        return;
      }
      submittingRef.current = true;
      onSubmit({
        description: description.trim(),
        attachments: FEEDBACK_ITEMS.filter((item) => checked[item.kind]).map(
          (item) => item.kind,
        ),
      });
    } else if (key.escape) {
      onCancel();
    }
  });

  const trimmed = description.trim();
  const subtitle = trimmed
    ? truncateToWidth(trimmed.split("\n")[0] ?? "", Math.max(10, columns - 8))
    : "Scan this session for yukino problems";
  const count = Object.values(checked).filter(Boolean).length;
  return (
    <SelectorFrame
      focusRef={focusRef}
      hint="↑↓ navigate · Space toggle · Enter review · Esc cancel"
      subtitle={subtitle}
      title="Feedback"
    >
      <Box paddingX={1}>
        <Text color={THEME.muted} wrap="truncate-end">
          {`${String(count)} attachment group(s) selected`}
        </Text>
      </Box>
      {FEEDBACK_ITEMS.map((item, index) => {
        const selected = index === cursor;
        const size = sizes[index];
        return (
          <Box
            key={item.kind}
            ref={selected ? focusRef : undefined}
            backgroundColor={selected ? THEME.selectedBg : undefined}
            paddingLeft={1}
            paddingRight={1}
            width="100%"
          >
            <Box flexGrow={1} flexShrink={1}>
              <Text
                color={selected ? THEME.accent : THEME.text}
                wrap="truncate-end"
              >
                {selected ? "› " : "  "}
                {checked[item.kind] ? "☑ " : "☐ "}
                {item.label}
              </Text>
            </Box>
            {size !== null && columns >= 40 ? (
              <Box flexShrink={0} width={11} justifyContent="flex-end">
                <Text color={THEME.muted} wrap="truncate-end">
                  {`~${formatBytes(size)}`}
                </Text>
              </Box>
            ) : null}
          </Box>
        );
      })}
      <Box paddingX={1}>
        <Text color={THEME.muted} wrap="truncate-end">
          {FEEDBACK_ITEMS[cursor]?.hint}
        </Text>
      </Box>
      <Box paddingLeft={1} paddingRight={1} width="100%">
        <Text color={THEME.dim} wrap="truncate-end">
          {truncateToWidth(
            "Secrets redacted. Review drafts before uploading or filing.",
            Math.max(10, columns - 4),
          )}
        </Text>
      </Box>
    </SelectorFrame>
  );
}
