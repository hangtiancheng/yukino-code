import { existsSync } from "node:fs";
import { dirname } from "node:path";

import yaml from "js-yaml";
import { z } from "zod";

import { CODE_MODE_INLINE_CHARS } from "@/code-mode/constants.js";
import {
  THEME_MODES,
  MAX_CODE_MODE_INLINE_BUDGET,
  MAX_DISPLAY_PADDING,
  MIN_COMPLETION_ROWS,
  MAX_COMPLETION_ROWS,
} from "@/config/constants.js";
import { globalConfigPath } from "@/config/provider-config.js";
import { writePrivateFileAtomicallySync } from "@/storage/private.js";
import { mkdirPrivateSync, readPrivateFileSync } from "@/storage/private.js";
import { withFileSyncLock } from "@/teams/file-lock.js";

export const CodeModeConfigSchema = z.strictObject({
  mode: z.enum(["off", "on", "only"]).default("off"),
  inline_budget: z
    .number()
    .int()
    .min(0)
    .max(MAX_CODE_MODE_INLINE_BUDGET)
    .default(CODE_MODE_INLINE_CHARS),
});
export const CodeModePatchSchema = z.strictObject({
  mode: CodeModeConfigSchema.shape.mode.unwrap().optional(),
  inline_budget: CodeModeConfigSchema.shape.inline_budget.unwrap().optional(),
});
export type CodeModeConfig = z.infer<typeof CodeModeConfigSchema>;
export const DisplayPreferencesSchema = z.strictObject({
  show_thinking: z.boolean().default(true),
  expanded_tools: z.boolean().default(false),
  editor_padding: z.number().int().min(0).max(MAX_DISPLAY_PADDING).default(1),
  output_padding: z.number().int().min(0).max(MAX_DISPLAY_PADDING).default(1),
  autocomplete_max_visible: z
    .number()
    .int()
    .min(MIN_COMPLETION_ROWS)
    .max(MAX_COMPLETION_ROWS)
    .default(8),
});
export const DisplayPreferencesPatchSchema = z.strictObject({
  show_thinking: DisplayPreferencesSchema.shape.show_thinking
    .unwrap()
    .optional(),
  expanded_tools: DisplayPreferencesSchema.shape.expanded_tools
    .unwrap()
    .optional(),
  editor_padding: DisplayPreferencesSchema.shape.editor_padding
    .unwrap()
    .optional(),
  output_padding: DisplayPreferencesSchema.shape.output_padding
    .unwrap()
    .optional(),
  autocomplete_max_visible:
    DisplayPreferencesSchema.shape.autocomplete_max_visible.unwrap().optional(),
});
export type DisplayPreferences = z.infer<typeof DisplayPreferencesSchema>;
export const RuntimePreferencesSchema = z.object({
  theme: z.enum(THEME_MODES).default("auto"),
  code_mode: CodeModeConfigSchema.default(() => CodeModeConfigSchema.parse({})),
  display: DisplayPreferencesSchema.default(() =>
    DisplayPreferencesSchema.parse({}),
  ),
  auto_compaction: z.boolean().default(true),
  auto_retry: z.boolean().default(true),
  steering_mode: z.enum(["all", "one-at-a-time"]).default("all"),
  follow_up_mode: z.enum(["all", "one-at-a-time"]).default("one-at-a-time"),
});
export type RuntimePreferences = z.infer<typeof RuntimePreferencesSchema>;
export const PreferencesPatchSchema = z.strictObject({
  theme: z.enum(THEME_MODES).optional(),
  code_mode: CodeModePatchSchema.optional(),
  display: DisplayPreferencesPatchSchema.optional(),
  auto_compaction: z.boolean().optional(),
  auto_retry: z.boolean().optional(),
  steering_mode: z.enum(["all", "one-at-a-time"]).optional(),
  follow_up_mode: z.enum(["all", "one-at-a-time"]).optional(),
});
export type PreferencesPatch = z.infer<typeof PreferencesPatchSchema>;

export function persistPreferences(
  patch: PreferencesPatch,
  path = globalConfigPath(),
): void {
  const parsed = PreferencesPatchSchema.parse(patch);
  mkdirPrivateSync(dirname(path));
  withFileSyncLock(path, () => {
    const current = z
      .record(z.string(), z.unknown())
      .parse(
        existsSync(path) ? yaml.load(readPrivateFileSync(path, "utf8")) : {},
      );
    const next = { ...current, ...parsed };
    for (const key of ["code_mode", "display"] as const) {
      if (parsed[key]) {
        next[key] = {
          ...z.record(z.string(), z.unknown()).parse(current[key] ?? {}),
          ...parsed[key],
        };
      }
    }
    writePrivateFileAtomicallySync(path, yaml.dump(next));
  });
}

export function mergePreferences<T extends PreferencesPatch>(
  base: T,
  patch: PreferencesPatch,
): T {
  const { code_mode: codeMode, display, ...values } = patch;
  return {
    ...base,
    ...values,
    ...(codeMode ? { code_mode: { ...base.code_mode, ...codeMode } } : {}),
    ...(display ? { display: { ...base.display, ...display } } : {}),
  };
}
