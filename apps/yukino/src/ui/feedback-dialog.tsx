import { Box, Text, useInput } from "ink";
import type { DOMElement } from "ink";
import { useRef, useState } from "react";

import { SelectorFrame } from "./selector-frame.js";
import { THEME } from "./styles.js";
import { truncateToWidth } from "./terminal-text.js";
import { TextField } from "./text-field.js";
import { useTerminalDimensions } from "./use-terminal-layout.js";

import { attachmentSizePreview } from "@/feedback/collect.js";
import type { AttachmentKind, FeedbackOptions } from "@/feedback/types.js";

interface Props {
  cwd: string;
  sessionId: string;
  initialDescription: string;
  onSubmit: (options: FeedbackOptions) => void;
  onCancel: () => void;
}

const ITEMS: {
  kind: AttachmentKind;
  label: string;
  hint: string;
}[] = [
  {
    kind: "session",
    label: "Session history",
    hint: "full conversation JSONL",
  },
  {
    kind: "tools",
    label: "Tool output",
    hint: "tool calls with arguments and results",
  },
  {
    kind: "file-history",
    label: "File history",
    hint: "rewind snapshots and file backups",
  },
  { kind: "log", label: "Log", hint: "yukino warnings and errors" },
  {
    kind: "env",
    label: "Environment info",
    hint: "OS/CPU, node/V8, memory, terminal, config, git",
  },
];

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
  initialDescription,
  onSubmit,
  onCancel,
}: Props) {
  const [phase, setPhase] = useState<"description" | "attachments">(
    initialDescription.trim() ? "attachments" : "description",
  );
  const [description, setDescription] = useState(initialDescription);
  const [cursor, setCursor] = useState(0);
  const [checked, setChecked] = useState<Record<AttachmentKind, boolean>>({
    session: true,
    tools: true,
    "file-history": true,
    log: true,
    env: true,
  });
  const focusRef = useRef<DOMElement>(null);
  const { columns } = useTerminalDimensions();
  // Sizes are computed once on mount; they only decorate the checklist.
  const sizes = useRef(
    ITEMS.map((item) => attachmentSizePreview(cwd, sessionId, item.kind)),
  );

  useInput((input, key) => {
    if (phase !== "attachments") {
      return;
    }
    if (key.upArrow) {
      setCursor((current) => (current > 0 ? current - 1 : ITEMS.length - 1));
    } else if (key.downArrow) {
      setCursor((current) => (current < ITEMS.length - 1 ? current + 1 : 0));
    } else if (input === " ") {
      const item = ITEMS[cursor];
      if (item) {
        setChecked((prev) => ({ ...prev, [item.kind]: !prev[item.kind] }));
      }
    } else if (key.return) {
      onSubmit({
        description: description.trim(),
        attachments: ITEMS.filter((item) => checked[item.kind]).map(
          (item) => item.kind,
        ),
      });
    } else if (key.escape) {
      if (initialDescription.trim()) {
        onCancel();
      } else {
        setPhase("description");
      }
    }
  });

  if (phase === "description") {
    return (
      <SelectorFrame
        hint="Enter continue · Escape cancel"
        subtitle="Describe what went wrong (optional)"
        title="Report a problem"
      >
        <TextField
          initialValue={description}
          prompt="→ "
          onChange={setDescription}
          onSubmit={(value) => {
            setDescription(value);
            setPhase("attachments");
          }}
          onEscape={onCancel}
        />
      </SelectorFrame>
    );
  }

  const subtitle = description.trim()
    ? truncateToWidth(
        description.trim().split("\n")[0] ?? "",
        Math.max(10, columns - 8),
      )
    : "no description — the model will analyze the session anyway";
  return (
    <SelectorFrame
      focusRef={focusRef}
      hint="Space toggle · Enter submit · Escape back"
      subtitle={subtitle}
      title="Feedback attachments"
    >
      {ITEMS.map((item, index) => {
        const selected = index === cursor;
        const size = sizes.current[index];
        const detail = [item.hint, size !== null ? formatBytes(size) : null]
          .filter((part): part is string => part !== null)
          .join(" · ");
        return (
          <Box
            key={item.kind}
            ref={selected ? focusRef : undefined}
            backgroundColor={selected ? THEME.selectedBg : undefined}
            paddingLeft={1}
            paddingRight={1}
            width="100%"
          >
            <Text
              color={selected ? THEME.accent : THEME.text}
              wrap="truncate-end"
            >
              {selected ? "› " : "  "}
              {checked[item.kind] ? "☑ " : "☐ "}
              {item.label}
              <Text color={THEME.muted}>{` · ${detail}`}</Text>
            </Text>
          </Box>
        );
      })}
      <Box paddingLeft={1} paddingRight={1} width="100%">
        <Text color={THEME.dim} wrap="truncate-end">
          {truncateToWidth(
            "Secrets are redacted before upload. The model analyzes this session and files harness issues automatically.",
            Math.max(10, columns - 4),
          )}
        </Text>
      </Box>
    </SelectorFrame>
  );
}
