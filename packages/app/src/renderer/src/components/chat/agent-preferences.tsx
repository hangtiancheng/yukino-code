import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { ChoiceSelect } from "@renderer/components/ui/select";
import { Switch } from "@renderer/components/ui/switch";
import type { SettingsSnapshot } from "@shared/ipc-types";
import type { PreferencesPatch } from "@yukino.js/yukino";
import { useState } from "react";
import { toast } from "sonner";

export function AgentPreferences({
  settings,
  disabled,
  onChange,
}: {
  settings: SettingsSnapshot;
  disabled: boolean;
  onChange: (value: SettingsSnapshot) => void;
}): React.JSX.Element {
  const [persist, setPersist] = useState(false);
  const [busy, setBusy] = useState(false);
  const [budget, setBudget] = useState(
    String(settings.preferences.values.code_mode.inline_budget),
  );
  const values = settings.preferences.values;
  const apply = (patch: PreferencesPatch): void => {
    setBusy(true);
    void window.api
      .setPreferences(patch, persist)
      .then(onChange)
      .catch((error: unknown) => toast.error(String(error)))
      .finally(() => {
        setBusy(false);
      });
  };
  const locked = disabled || busy;
  return (
    <section className="bg-muted/40 space-y-4 rounded-xl border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold">Agent preferences</h3>
        <ChoiceSelect
          label="Save preferences to"
          value={persist ? "global" : "session"}
          disabled={locked}
          onValueChange={(value) => {
            setPersist(value === "global");
          }}
          options={[
            { value: "session", label: "This session" },
            { value: "global", label: "Global config" },
          ]}
        />
      </div>
      <p className="text-muted-foreground text-xs">
        Changes apply immediately. Global settings are shared with the CLI.
      </p>
      <ChoiceSelect
        label="Tool presentation"
        value={values.code_mode.mode}
        disabled={locked}
        onValueChange={(mode: "off" | "on" | "only") => {
          apply({ code_mode: { mode } });
        }}
        options={[
          { value: "off", label: "Direct tools" },
          { value: "on", label: "Direct tools + Code Mode" },
          { value: "only", label: "Code Mode only" },
        ]}
      />
      <label className="block space-y-2 text-xs">
        <span>Inline declaration budget (characters)</span>
        <div className="flex gap-2">
          <Input
            aria-label="Inline declaration budget"
            type="number"
            min={0}
            max={2097152}
            step={1000}
            value={budget}
            disabled={locked}
            onChange={(event) => {
              setBudget(event.target.value);
            }}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={
              locked ||
              !budget ||
              !Number.isInteger(Number(budget)) ||
              Number(budget) < 0 ||
              Number(budget) > 2097152
            }
            onClick={() => {
              apply({ code_mode: { inline_budget: Number(budget) } });
            }}
          >
            Apply budget
          </Button>
        </div>
      </label>
      {(
        [
          ["auto_compaction", "Automatic context compaction"],
          ["auto_retry", "Automatic retry"],
        ] as const
      ).map(([field, label]) => (
        <label
          key={field}
          className="flex items-center justify-between gap-3 text-xs"
        >
          {label}
          <Switch
            aria-label={label}
            checked={values[field]}
            disabled={locked}
            onCheckedChange={(value) => {
              apply({ [field]: value });
            }}
          />
        </label>
      ))}
      {(
        [
          ["steering_mode", "Steering delivery"],
          ["follow_up_mode", "Follow-up delivery"],
        ] as const
      ).map(([field, label]) => (
        <ChoiceSelect
          key={field}
          label={label}
          value={values[field]}
          disabled={locked}
          onValueChange={(value: "all" | "one-at-a-time") => {
            apply({ [field]: value });
          }}
          options={[
            { value: "all", label: `${label}: all at once` },
            { value: "one-at-a-time", label: `${label}: one at a time` },
          ]}
        />
      ))}
      <div className="space-y-3 border-t pt-3">
        <h4 className="text-xs font-semibold">Display</h4>
        {(
          [
            ["show_thinking", "Show thinking traces"],
            ["expanded_tools", "Expand tool results"],
          ] as const
        ).map(([field, label]) => (
          <label
            key={field}
            className="flex items-center justify-between gap-3 text-xs"
          >
            {label}
            <Switch
              aria-label={label}
              checked={values.display[field]}
              disabled={locked}
              onCheckedChange={(value) => {
                apply({ display: { [field]: value } });
              }}
            />
          </label>
        ))}
        {(
          [
            ["editor_padding", "Composer padding", 0, 3],
            ["output_padding", "Conversation spacing", 0, 3],
            ["autocomplete_max_visible", "Command suggestions", 3, 20],
          ] as const
        ).map(([field, label, min, max]) => (
          <ChoiceSelect
            key={field}
            label={label}
            disabled={locked}
            value={String(values.display[field])}
            onValueChange={(value) => {
              apply({ display: { [field]: Number(value) } });
            }}
            options={Array.from({ length: max - min + 1 }, (_, index) => ({
              value: String(index + min),
              label: `${label}: ${index + min}`,
            }))}
          />
        ))}
      </div>
      <details className="text-muted-foreground text-xs">
        <summary className="cursor-pointer">Setting sources</summary>
        <div className="mt-2 space-y-1.5">
          {settings.preferences.sources.map((source) => (
            <p key={source.field} className="break-all">
              {source.field}: {source.scope}
              {source.path ? ` · ${source.path}` : ""}
            </p>
          ))}
        </div>
      </details>
      <Button
        size="sm"
        variant="outline"
        disabled={locked}
        onClick={() => {
          setBusy(true);
          void window.api
            .reloadResources()
            .then(() => window.api.getSettings())
            .then(onChange)
            .catch((error: unknown) => toast.error(String(error)))
            .finally(() => {
              setBusy(false);
            });
        }}
      >
        Reload settings & resources
      </Button>
    </section>
  );
}
