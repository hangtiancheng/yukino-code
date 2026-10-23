import { useState } from "react";

import { Modal, ModalHeader } from "#/components/modal.js";
import { PickerList } from "#/components/picker-list.js";
import { PROTOCOLS } from "#/constants.js";
import type { ProviderListPayload, ProviderSavePayload } from "#/types.js";

interface ProviderDialogProps {
  state: ProviderListPayload;
  onSelect: (index: number) => void;
  onSave: (form: ProviderSavePayload) => void;
  onClose: () => void;
}

const inputClass =
  "w-full rounded-none border border-border bg-bg px-3 py-2 font-mono text-[13px] text-bright outline-none placeholder:text-dim focus:border-accent";

/** Provider switcher + login form for /login (terminal provider dialogs parity). */
export function ProviderDialog({
  state,
  onSelect,
  onSave,
  onClose,
}: ProviderDialogProps) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [protocol, setProtocol] =
    useState<ProviderSavePayload["protocol"]>("anthropic");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [error, setError] = useState("");

  const submitForm = (): void => {
    if (!name.trim() || !baseUrl.trim() || !apiKey.trim() || !model.trim()) {
      setError("Name, base URL, API key and model are all required.");
      return;
    }
    if (!/^https?:\/\//i.test(baseUrl.trim())) {
      setError("Use an HTTP(S) base URL.");
      return;
    }
    onSave({
      name: name.trim(),
      protocol,
      base_url: baseUrl.trim(),
      api_key: apiKey.trim(),
      model: model.trim(),
    });
  };

  return (
    <Modal label="Providers" onEscape={onClose}>
      <ModalHeader
        subtitle={
          adding
            ? "Saved to the global config and activated immediately."
            : "Pick a configured provider, or add a new one."
        }
        title={adding ? "Add a provider" : "Providers"}
      />
      {!adding ? (
        <>
          <PickerList
            items={state.providers.map((provider, index) => ({
              id: String(index),
              label: provider.name,
              detail: `${provider.protocol} · ${provider.model} · ${provider.base_url}`,
              current: index === state.current,
            }))}
            onSelect={(id) => {
              onSelect(Number(id));
            }}
            onClose={onClose}
          />
          <div className="flex items-center justify-between border-t border-border px-4 py-3 sm:px-5">
            <button
              type="button"
              onClick={() => {
                setAdding(true);
              }}
              className="cursor-pointer rounded-none border border-accent/40 px-3.5 py-1.5 text-[13px] font-semibold text-accent transition-colors hover:bg-accent/10"
            >
              Add provider…
            </button>
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
          <form
            className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4 sm:px-5"
            onSubmit={(e) => {
              e.preventDefault();
              submitForm();
            }}
          >
            <label className="block">
              <span className="mb-1 block text-xs text-dim">Name</span>
              <input
                className={inputClass}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                }}
                placeholder="my-provider"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-dim">Protocol</span>
              <select
                className={inputClass}
                value={protocol}
                onChange={(e) => {
                  setProtocol(
                    PROTOCOLS.find((entry) => entry === e.target.value) ??
                      "anthropic",
                  );
                }}
              >
                {PROTOCOLS.map((entry) => (
                  <option key={entry} value={entry}>
                    {entry}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-dim">Base URL</span>
              <input
                className={inputClass}
                value={baseUrl}
                onChange={(e) => {
                  setBaseUrl(e.target.value);
                }}
                placeholder="https://api.example.com"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-dim">API key</span>
              <input
                className={inputClass}
                type="password"
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                }}
                placeholder="sk-…"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-dim">Model</span>
              <input
                className={inputClass}
                value={model}
                onChange={(e) => {
                  setModel(e.target.value);
                }}
                placeholder="model id"
              />
            </label>
            {error && <p className="text-xs text-red">{error}</p>}
            <button type="submit" className="hidden" aria-hidden="true" />
          </form>
          <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3 sm:px-5">
            <button
              type="button"
              onClick={() => {
                setAdding(false);
                setError("");
              }}
              className="cursor-pointer rounded-none border border-border px-3.5 py-1.5 text-[13px] font-semibold text-base transition-colors hover:bg-bg"
            >
              Back
            </button>
            <button
              type="button"
              onClick={submitForm}
              className="cursor-pointer rounded-none bg-accent px-3.5 py-1.5 text-[13px] font-semibold text-accent-contrast transition-opacity hover:opacity-90"
            >
              Save & activate
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
