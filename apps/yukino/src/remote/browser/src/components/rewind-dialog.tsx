import { useState } from "react";

import { Modal, ModalHeader } from "#/components/modal.js";
import { RESTORE_OPTIONS } from "#/constants.js";
import type { RewindChoice, RewindSnapshot } from "#/types.js";

interface RewindDialogProps {
  snapshots: RewindSnapshot[];
  onAction: (snapshotId: string, action: RewindChoice) => void;
  onClose: () => void;
}

function formatTimestamp(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) {
    return iso;
  }
  return new Date(time).toLocaleString();
}

/** Checkpoint rewind dialog for /rewind (terminal rewind-dialog parity). */
export function RewindDialog({
  snapshots,
  onAction,
  onClose,
}: RewindDialogProps) {
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <Modal label="Rewind to a checkpoint" onEscape={onClose}>
      {selected === null ? (
        <>
          <ModalHeader
            subtitle="Checkpoints are captured before the agent edits files."
            title="Rewind to a checkpoint"
          />
          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
            {[...snapshots].reverse().map((snap) => (
              <button
                key={snap.id}
                type="button"
                onClick={() => {
                  setSelected(snap.id);
                }}
                className="flex w-full cursor-pointer items-center gap-3 rounded-none px-3 py-2.5 text-left transition-colors hover:bg-bg"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-bright">
                    {snap.userText || "(no prompt)"}
                  </span>
                  <span className="mt-0.5 block font-mono text-[11px] text-dim">
                    {`${formatTimestamp(snap.timestamp)} · ${String(snap.fileCount)} file(s)`}
                  </span>
                </span>
              </button>
            ))}
          </div>
          <div className="flex items-center justify-end border-t border-border px-4 py-3 sm:px-5">
            <button
              type="button"
              onClick={onClose}
              className="cursor-pointer rounded-none border border-border px-3.5 py-1.5 text-[13px] font-semibold text-base transition-colors hover:bg-bg"
            >
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <ModalHeader
            subtitle={
              snapshots.find((snap) => snap.id === selected)?.userText ||
              "(no prompt)"
            }
            title="What should be restored?"
          />
          <div className="min-h-0 flex-1 px-2 py-2">
            {RESTORE_OPTIONS.map((option) => (
              <button
                key={option.action}
                type="button"
                onClick={() => {
                  onAction(selected, option.action);
                }}
                className="flex w-full cursor-pointer items-center rounded-none px-3 py-2.5 text-left text-sm text-bright transition-colors hover:bg-bg"
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="flex items-center justify-end border-t border-border px-4 py-3 sm:px-5">
            <button
              type="button"
              onClick={() => {
                setSelected(null);
              }}
              className="cursor-pointer rounded-none border border-border px-3.5 py-1.5 text-[13px] font-semibold text-base transition-colors hover:bg-bg"
            >
              Back
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
