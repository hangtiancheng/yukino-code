import { Box, Text, useInput } from "ink";
import { useState } from "react";

import { SelectorFrame } from "./selector-frame.js";

import type { Snapshot } from "@/file-history/index.js";
import { ICONS, THEME } from "@/ui/styles.js";

export type RewindAction =
  | { type: "code_and_conversation"; snapshotIndex: number }
  | { type: "conversation_only"; snapshotIndex: number }
  | { type: "code_only"; snapshotIndex: number }
  | { type: "cancel" };

interface Props {
  snapshots: Snapshot[];
  onComplete: (action: RewindAction) => void;
  onCancel: () => void;
}

const RESTORE_OPTIONS = [
  "Restore code and conversation",
  "Restore conversation only",
  "Restore code only",
  "Never mind",
];

function RewindDialog({ snapshots, onComplete, onCancel }: Props) {
  const [phase, setPhase] = useState<0 | 1>(0);
  const [cursor, setCursor] = useState(Math.max(0, snapshots.length - 1));
  const [optionCursor, setOptionCursor] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput((_input, key) => {
    if (phase === 0) {
      if (key.upArrow) {
        setCursor((current) =>
          current > 0 ? current - 1 : snapshots.length - 1,
        );
      } else if (key.downArrow) {
        setCursor((current) =>
          current < snapshots.length - 1 ? current + 1 : 0,
        );
      } else if (key.return && snapshots[cursor]) {
        setSelectedIndex(cursor);
        setPhase(1);
        setOptionCursor(0);
      } else if (key.escape) {
        onCancel();
      }
      return;
    }

    if (key.upArrow) {
      setOptionCursor((current) =>
        current > 0 ? current - 1 : RESTORE_OPTIONS.length - 1,
      );
    } else if (key.downArrow) {
      setOptionCursor((current) =>
        current < RESTORE_OPTIONS.length - 1 ? current + 1 : 0,
      );
    } else if (key.escape) {
      setPhase(0);
    } else if (key.return) {
      if (optionCursor === 0) {
        onComplete({
          type: "code_and_conversation",
          snapshotIndex: selectedIndex,
        });
      } else if (optionCursor === 1) {
        onComplete({ type: "conversation_only", snapshotIndex: selectedIndex });
      } else if (optionCursor === 2) {
        onComplete({ type: "code_only", snapshotIndex: selectedIndex });
      } else {
        onComplete({ type: "cancel" });
      }
    }
  });

  if (phase === 0) {
    return (
      <SelectorFrame
        hint="↑↓ navigate · Enter select · Escape cancel"
        title="Rewind to checkpoint"
      >
        {snapshots.map((snapshot, index) => {
          const selected = index === cursor;
          return (
            <Box
              key={snapshot.timestamp}
              backgroundColor={selected ? THEME.selectedBg : undefined}
              paddingLeft={1}
              paddingRight={1}
              width="100%"
            >
              <Text color={selected ? THEME.accent : THEME.text}>
                {selected ? "› " : "  "}
                {snapshot.userText || "(empty)"}
              </Text>
              <Text color={THEME.muted} wrap="truncate-end">
                {` · ${formatAgo(snapshot.timestamp)} · ${String(Object.keys(snapshot.backups).length)} files`}
              </Text>
            </Box>
          );
        })}
      </SelectorFrame>
    );
  }

  const snapshot = snapshots[selectedIndex];
  return (
    <SelectorFrame
      hint="↑↓ navigate · Enter select · Escape back"
      subtitle={snapshot?.userText || "(empty)"}
      title="Choose rewind scope"
    >
      {RESTORE_OPTIONS.map((option, index) => {
        const selected = index === optionCursor;
        return (
          <Box
            key={option}
            backgroundColor={selected ? THEME.selectedBg : undefined}
            paddingLeft={1}
            paddingRight={1}
            width="100%"
          >
            <Text color={selected ? THEME.accent : THEME.muted}>
              {selected ? `${ICONS.arrow} ` : "  "}
              {option}
            </Text>
          </Box>
        );
      })}
    </SelectorFrame>
  );
}

function formatAgo(timestamp: string): string {
  const seconds = Math.floor(
    (Date.now() - new Date(timestamp).getTime()) / 1000,
  );
  if (seconds < 60) {
    return `${String(seconds)}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${String(minutes)}m ago`;
  }
  return `${String(Math.floor(minutes / 60))}h ago`;
}

export default RewindDialog;
