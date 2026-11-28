import { useInput } from "ink";
import { useState } from "react";

import {
  PreferencesPatchSchema,
  type PreferencesPatch,
  type RuntimePreferences,
} from "@/config/preferences.js";
import type { ProjectSource } from "@/project/types.js";
import { SelectorList, SelectorListRow } from "@/ui/selector-list.js";
import { updateSelectorQuery } from "@/ui/selector-search.js";
import { plainTerminalLine, visibleWidth } from "@/ui/terminal-text.js";
import { asErrorString } from "@/utils/format.js";

const SOURCE_LABELS = {
  default: "default",
  global: "user",
  project: "project",
  override: "session/invocation",
} as const;

function displaySettingValue(
  key: string,
  value: boolean | number | string,
): string {
  if (key === "theme") {
    return value === "dark"
      ? "Mocha · Dark"
      : value === "light"
        ? "Latte · Light"
        : "System";
  }
  return typeof value === "boolean"
    ? value
      ? "On"
      : "Off"
    : plainTerminalLine(String(value));
}

interface Props {
  values: RuntimePreferences;
  sources: ProjectSource[];
  model: string;
  thinking: string;
  onModel: () => Promise<void>;
  onThinking: () => void;
  onChange: (patch: PreferencesPatch, persist: boolean) => Promise<void>;
  onClose: () => void;
}

export function SettingsDialog({
  values,
  sources,
  model,
  thinking,
  onModel,
  onThinking,
  onChange,
  onClose,
}: Props) {
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState("model");
  const [persist, setPersist] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const rows = [
    { key: "model", label: "Model", value: model, choices: [] },
    { key: "thinking", label: "Thinking", value: thinking, choices: [] },
    {
      key: "theme",
      label: "Theme",
      value: values.theme,
      choices: ["auto", "dark", "light"],
    },
    {
      key: "auto_compaction",
      label: "Automatic compaction",
      value: values.auto_compaction,
      choices: [true, false],
    },
    {
      key: "auto_retry",
      label: "Automatic retry",
      value: values.auto_retry,
      choices: [true, false],
    },
    {
      key: "steering_mode",
      label: "Steering delivery",
      value: values.steering_mode,
      choices: ["all", "one-at-a-time"],
    },
    {
      key: "follow_up_mode",
      label: "Follow-up delivery",
      value: values.follow_up_mode,
      choices: ["all", "one-at-a-time"],
    },
    {
      key: "code_mode.mode",
      label: "Tool presentation",
      value: values.code_mode.mode,
      choices: ["off", "on", "only"],
    },
    {
      key: "code_mode.inline_budget",
      label: "Inline declarations (characters)",
      value: values.code_mode.inline_budget,
      choices: [0, 4000, 12000, 24000, 48000],
    },
    {
      key: "display.show_thinking",
      label: "Show thinking",
      value: values.display.show_thinking,
      choices: [true, false],
    },
    {
      key: "display.expanded_tools",
      label: "Expand tool output",
      value: values.display.expanded_tools,
      choices: [false, true],
    },
    {
      key: "display.editor_padding",
      label: "Editor padding",
      value: values.display.editor_padding,
      choices: [0, 1, 2, 3],
    },
    {
      key: "display.output_padding",
      label: "Output padding",
      value: values.display.output_padding,
      choices: [0, 1, 2, 3],
    },
    {
      key: "display.autocomplete_max_visible",
      label: "Completion rows",
      value: values.display.autocomplete_max_visible,
      choices: [3, 5, 8, 12, 20],
    },
  ].filter((row) =>
    `${row.label} ${row.value} ${displaySettingValue(row.key, row.value)}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const labelWidth = Math.max(...rows.map((row) => visibleWidth(row.label)), 0);
  const cursor = Math.max(
    0,
    rows.findIndex((row) => row.key === focused),
  );
  useInput((input, key) => {
    if (busy) {
      return;
    }
    if (key.escape) {
      onClose();
      return;
    }
    if (key.ctrl && input === "s") {
      setPersist((value) => !value);
      return;
    }
    if (key.upArrow || key.downArrow) {
      if (rows.length) {
        setFocused(
          rows[(cursor + (key.upArrow ? -1 : 1) + rows.length) % rows.length]
            .key,
        );
      }
      return;
    }
    if (key.return || key.leftArrow || key.rightArrow) {
      const row = rows[cursor];
      if (!row) {
        return;
      }
      setBusy(true);
      setError("");
      void Promise.resolve()
        .then(async () => {
          if (row.key === "model") {
            await onModel();
            return;
          }
          if (row.key === "thinking") {
            onThinking();
            return;
          }
          const choices: readonly (boolean | number | string)[] = row.choices;
          const index = choices.indexOf(row.value);
          const value =
            choices[
              (index + (key.leftArrow ? -1 : 1) + choices.length) %
                choices.length
            ];
          const [group, field] = row.key.split(".");
          const patch = field
            ? { [group]: { [field]: value } }
            : { [group]: value };
          await onChange(PreferencesPatchSchema.parse(patch), persist);
        })
        .catch((cause: unknown) => {
          setError(asErrorString(cause));
        })
        .finally(() => {
          setBusy(false);
        });
      return;
    }
    setQuery(updateSelectorQuery(query, input, key));
  });
  return (
    <SelectorList
      title="Settings"
      subtitle={`${persist ? "Session override + save globally" : "Session override"} · model choices are saved with the session`}
      query={query}
      cursor={cursor}
      itemCount={rows.length}
      totalCount={14}
      itemHeight={1}
      emptyText="No matching settings"
      error={error}
      searchActive={!busy}
      hint={
        busy
          ? "Applying…"
          : "←/→ change · Ctrl+S save scope · Enter change · Esc close"
      }
    >
      {(start, count, width) =>
        rows
          .slice(start, start + count)
          .map((row, index) => (
            <SelectorListRow
              key={row.key}
              label={
                width >= 54
                  ? `${row.label.padEnd(labelWidth)}  ${displaySettingValue(row.key, row.value)}`
                  : `${displaySettingValue(row.key, row.value)}  ${row.label}`
              }
              description={
                row.key === "model" || row.key === "thinking"
                  ? "session"
                  : SOURCE_LABELS[
                      sources.find(
                        (source) => source.field === row.key.split(".")[0],
                      )?.scope ?? "default"
                    ]
              }
              current={false}
              focused={start + index === cursor}
              width={width}
            />
          ))
      }
    </SelectorList>
  );
}
