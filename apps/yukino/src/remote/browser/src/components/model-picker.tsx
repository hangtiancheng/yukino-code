import type { ModelListPayload } from "@browser/types";

import { Modal, ModalHeader } from "./modal";

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
        {state.status === "ready" &&
          state.models.map((model) => {
            const active = model.id === state.current;
            return (
              <button
                key={model.id}
                type="button"
                onClick={() => {
                  onSelect(model.id);
                }}
                className={`flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-bg ${active ? "bg-accent/8" : ""}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[13px] text-bright">
                    {model.id}
                  </span>
                  {model.name && model.name !== model.id && (
                    <span className="mt-0.5 block truncate text-xs text-dim">
                      {model.name}
                    </span>
                  )}
                </span>
                {active && (
                  <span className="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 font-mono text-[10px] font-semibold text-accent">
                    current
                  </span>
                )}
              </button>
            );
          })}
      </div>
      <div className="flex items-center justify-end border-t border-border px-4 py-3 sm:px-5">
        <button
          type="button"
          onClick={onClose}
          className="cursor-pointer rounded-lg border border-border px-3.5 py-1.5 text-[13px] font-semibold text-base transition-colors hover:bg-bg"
        >
          Cancel
        </button>
      </div>
    </Modal>
  );
}
