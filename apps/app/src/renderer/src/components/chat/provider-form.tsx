import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { Label } from "@renderer/components/ui/label";
import { ChoiceSelect } from "@renderer/components/ui/select";
import type { ProviderInput } from "@shared/ipc-types";
import { useId, useState } from "react";
import { toast } from "sonner";

export function ProviderForm({
  onSaved,
  onCancel,
}: {
  onSaved: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const id = useId();
  const [input, setInput] = useState<ProviderInput>({
    name: "",
    protocol: "openai",
    base_url: "",
    api_key: "",
    model: "",
  });
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="space-y-3 rounded-lg border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        void window.api
          .saveProvider(input)
          .then(() => {
            onSaved();
          })
          .catch((error: unknown) => toast.error(String(error)))
          .finally(() => {
            setBusy(false);
          });
      }}
    >
      {(
        [
          { key: "name", label: "Name", type: "text" },
          { key: "base_url", label: "API URL", type: "url" },
          { key: "api_key", label: "API Key", type: "password" },
          { key: "model", label: "Model", type: "text" },
        ] as const
      ).map((field) => (
        <div className="space-y-1.5" key={field.key}>
          <Label htmlFor={`${id}-${field.key}`}>{field.label}</Label>
          <Input
            id={`${id}-${field.key}`}
            type={field.type}
            autoComplete="off"
            spellCheck={false}
            required
            disabled={busy}
            value={input[field.key]}
            onChange={(event) => {
              setInput((current) => ({
                ...current,
                [field.key]: event.target.value,
              }));
            }}
          />
        </div>
      ))}
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-protocol`}>Protocol</Label>
        <ChoiceSelect
          id={`${id}-protocol`}
          label="Protocol"
          className="w-full"
          disabled={busy}
          value={input.protocol}
          onValueChange={(protocol) => {
            setInput((current) => ({ ...current, protocol }));
          }}
          options={[
            { value: "openai", label: "OpenAI Responses" },
            { value: "openai-compat", label: "OpenAI Chat Completions" },
            { value: "anthropic", label: "Anthropic" },
          ]}
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? "Connecting" : "Save and connect"}
        </Button>
      </div>
    </form>
  );
}
