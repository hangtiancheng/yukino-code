import { useState } from "react";

import { Modal, ModalHeader } from "#/components/modal.js";
import { PickerList } from "#/components/picker-list.js";
import { Button } from "#/components/ui/button.js";
import { DialogClose } from "#/components/ui/dialog.js";
import { Input } from "#/components/ui/input.js";
import { Label } from "#/components/ui/label.js";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "#/components/ui/select.js";
import { PROTOCOLS } from "#/constants.js";
import type { ProviderListPayload, ProviderSavePayload } from "#/types.js";
import { ProviderSaveSchema } from "@/remote/protocol.js";

interface ProviderDialogProps {
  state: ProviderListPayload;
  onSelect: (index: number) => void;
  onSave: (form: ProviderSavePayload) => void;
  onClose: () => void;
}

const inputClass =
  "w-full rounded-lg border border-border bg-bg px-3 py-2 font-mono text-[13px] text-bright outline-none placeholder:text-dim focus:border-accent";

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
    const parsed = ProviderSaveSchema.safeParse({
      name,
      protocol,
      base_url: baseUrl.trim(),
      api_key: apiKey,
      model,
    });
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => issue.message).join("; "));
      return;
    }
    onSave(parsed.data);
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
          />
          <div className="flex items-center justify-between border-t border-border px-4 py-3 sm:px-5">
            <Button
              type="button"
              onClick={() => {
                setAdding(true);
              }}
              className="cursor-pointer rounded-lg border border-accent/40 px-3.5 py-1.5 text-[13px] font-semibold text-accent transition-colors hover:bg-accent-bg"
            >
              Add provider…
            </Button>
            <Button
              type="button"
              render={<DialogClose />}
              className="cursor-pointer rounded-lg border border-border px-3.5 py-1.5 text-[13px] font-semibold text-base transition-colors hover:bg-selected"
            >
              Cancel
            </Button>
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
            <Label className="block">
              <span className="mb-1 block text-xs text-dim">Name</span>
              <Input
                className={inputClass}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                }}
                placeholder="my-provider"
              />
            </Label>
            <Label className="block">
              <span className="mb-1 block text-xs text-dim">Protocol</span>
              <Select
                value={protocol}
                onValueChange={(value) => {
                  const selected = PROTOCOLS.find((entry) => entry === value);
                  if (selected) {
                    setProtocol(selected);
                  }
                }}
              >
                <SelectTrigger className={inputClass} aria-label="Protocol">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROTOCOLS.map((entry) => (
                    <SelectItem key={entry} value={entry}>
                      {entry}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Label>
            <Label className="block">
              <span className="mb-1 block text-xs text-dim">Base URL</span>
              <Input
                className={inputClass}
                value={baseUrl}
                onChange={(e) => {
                  setBaseUrl(e.target.value);
                }}
                placeholder="https://api.example.com"
              />
            </Label>
            <Label className="block">
              <span className="mb-1 block text-xs text-dim">API key</span>
              <Input
                className={inputClass}
                type="password"
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                }}
                placeholder="sk-…"
              />
            </Label>
            <Label className="block">
              <span className="mb-1 block text-xs text-dim">Model</span>
              <Input
                className={inputClass}
                value={model}
                onChange={(e) => {
                  setModel(e.target.value);
                }}
                placeholder="model id"
              />
            </Label>
            {error && <p className="text-xs text-error">{error}</p>}
            <Button type="submit" className="hidden" aria-hidden="true" />
          </form>
          <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3 sm:px-5">
            <Button
              type="button"
              onClick={() => {
                setAdding(false);
                setError("");
              }}
              className="cursor-pointer rounded-lg border border-border px-3.5 py-1.5 text-[13px] font-semibold text-base transition-colors hover:bg-selected"
            >
              Back
            </Button>
            <Button
              type="button"
              onClick={submitForm}
              className="cursor-pointer rounded-lg bg-accent px-3.5 py-1.5 text-[13px] font-semibold text-accent-contrast transition-opacity hover:opacity-90"
            >
              Save & activate
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
