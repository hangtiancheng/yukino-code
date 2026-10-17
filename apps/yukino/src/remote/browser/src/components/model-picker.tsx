import type { ModelListPayload } from "@browser/types";

import { Modal, ModalHeader } from "./modal";
import { PickerList } from "./picker-list";

interface ModelPickerProps {
  state: ModelListPayload;
  onSelect: (model: string) => void;
  onClose: () => void;
}

/** Model picker for /model (terminal model-select parity). */
export function ModelPicker({ state, onSelect, onClose }: ModelPickerProps) {
  return (
    <Modal label="Switch model" onEscape={onClose}>
      <ModalHeader
        subtitle={`Current: ${state.current || "unknown"}`}
        title="Switch model"
      />
      {state.status === "ready" ? (
        <PickerList
          items={state.models.map((model) => ({
            id: model.id,
            label: model.id,
            detail:
              model.name && model.name !== model.id ? model.name : undefined,
            current: model.id === state.current,
          }))}
          onSelect={onSelect}
          onClose={onClose}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {state.status === "loading" && (
            <p className="px-3 py-6 text-center text-sm text-dim">
              Discovering models…
            </p>
          )}
          {state.status === "error" && (
            <p className="px-3 py-6 text-center text-sm text-red">
              Model discovery failed. Check the provider endpoint.
            </p>
          )}
          {state.status === "empty" && (
            <p className="px-3 py-6 text-center text-sm text-dim">
              The provider did not advertise any models.
            </p>
          )}
        </div>
      )}
      <div className="flex items-center justify-end border-t border-border px-4 py-3 sm:px-5">
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
