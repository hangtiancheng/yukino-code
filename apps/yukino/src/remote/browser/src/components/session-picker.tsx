import { Modal, ModalHeader } from "#/components/modal.js";
import { PickerList } from "#/components/picker-list.js";
import type { SessionSummary } from "#/types.js";

interface SessionPickerProps {
  sessions: SessionSummary[];
  onPick: (id: string) => void;
  onClose: () => void;
}

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return "";
  }
  const diffMs = Date.now() - then;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${String(minutes)}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${String(hours)}h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 30) {
    return `${String(days)}d ago`;
  }
  return new Date(then).toLocaleDateString();
}

/** Session list for /resume; picking a row resumes that session. */
export function SessionPicker({
  sessions,
  onPick,
  onClose,
}: SessionPickerProps) {
  return (
    <Modal label="Resume a session" onEscape={onClose}>
      <ModalHeader
        subtitle="Pick a session to replace the current conversation."
        title="Resume a session"
      />
      <PickerList
        items={sessions.map((session) => ({
          id: session.id,
          label: session.firstMessage || "(no messages)",
          detail: session.id,
          meta: `${String(session.messageCount)} msgs · ${relativeTime(session.modTime)}`,
        }))}
        onSelect={onPick}
        onClose={onClose}
      />
      <div className="flex items-center justify-between border-t border-border px-4 sm:px-5 py-3">
        <p className="text-[11px] text-dim">
          Or type <span className="font-mono text-dim">/resume &lt;id&gt;</span>
        </p>
        <button
          type="button"
          onClick={onClose}
          className="cursor-pointer rounded-none border border-border px-3.5 py-1.5 text-[13px] font-semibold text-base transition-colors hover:bg-bg"
        >
          Cancel
        </button>
      </div>
    </Modal>
  );
}
