import type { ThinkingFormPayload } from "@browser/types";

import { Modal, ModalHeader } from "./modal";

interface ThinkingPickerProps {
  form: ThinkingFormPayload;
  onSelect: (level: string) => void;
  onClose: () => void;
}

/** Thinking-level picker for bare /thinking (terminal parity). */
export function ThinkingPicker({
  form,
  onSelect,
  onClose,
}: ThinkingPickerProps) {
  return (
    <Modal label="Set thinking level" onEscape={onClose} maxWidth="max-w-sm">
      <ModalHeader
        subtitle={`Current: ${form.current}`}
        title="Set thinking level"
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {form.levels.map((level) => {
          const active = level === form.current;
          return (
            <button
              key={level}
              type="button"
              onClick={() => {
                onSelect(level);
              }}
              className={`flex w-full cursor-pointer items-center justify-between rounded-lg px-3 py-2.5 text-left font-mono text-[13px] transition-colors hover:bg-bg ${active ? "bg-accent/8 text-accent" : "text-bright"}`}
            >
              {level}
              {active && (
                <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-semibold">
                  current
                </span>
              )}
            </button>
          );
        })}
      </div>
    </Modal>
  );
}
