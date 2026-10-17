import type { ThinkingFormPayload } from "@browser/types";

import { Modal, ModalHeader } from "./modal";
import { PickerList } from "./picker-list";

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
      <PickerList
        items={form.levels.map((level) => ({
          id: level,
          label: level,
          current: level === form.current,
        }))}
        onSelect={onSelect}
        onClose={onClose}
      />
    </Modal>
  );
}
