import type { AppConfig } from "@/config/index.js";
import {
  RuntimePreferencesSchema,
  PreferencesPatchSchema,
  mergePreferences,
  type PreferencesPatch,
} from "@/config/preferences.js";
import type { AgentRuntime } from "@/runtime/types.js";
import { BashTool } from "@/tools/bash.js";
import { CodeModeTool } from "@/tools/code-mode.js";

export function applyRuntimePreferences(
  runtime: AgentRuntime,
  patch: PreferencesPatch,
): void {
  const parsed = PreferencesPatchSchema.parse(patch);
  Object.assign(
    runtime.preferences,
    RuntimePreferencesSchema.parse(
      mergePreferences(runtime.preferences, parsed),
    ),
  );
  if (parsed.code_mode) {
    const mode = runtime.preferences.code_mode;
    const policy = runtime.registry.getPolicy();
    if (mode.mode !== "off" && !runtime.registry.get("CodeMode")) {
      runtime.registry.register(new CodeModeTool());
    }
    if (
      policy.codeModeEnabled !== (mode.mode !== "off") ||
      policy.codeModeMode !== mode.mode ||
      policy.codeModeInlineBudget !== mode.inline_budget
    ) {
      runtime.registry.setPolicy({
        ...policy,
        codeModeEnabled: mode.mode !== "off",
        codeModeMode: mode.mode,
        codeModeInlineBudget: mode.inline_budget,
      });
    }
  }
  if (parsed.auto_retry === false) {
    runtime.abortRetry();
  }
}

export function configureRuntimeShell(
  runtime: AgentRuntime,
  config: Pick<AppConfig, "shellPath" | "shellCommandPrefix">,
): void {
  const shell = runtime.registry.getInstanceOf("Bash", BashTool);
  if (shell) {
    shell.shellPath = config.shellPath;
    shell.shellCommandPrefix = config.shellCommandPrefix;
  }
}
