import { MCP_TOOL_PREFIX } from "@/mcp/constants.js";
import {
  DEFERRED_GUIDANCE_MARKER,
  TOOL_GUIDANCE_MARKER,
} from "@/prompt/constants.js";
import {
  AGENT_DELEGATION_RULE,
  AGENT_ONE_SHOT_RULE,
  BACKGROUND_TASK_STOP_RULE,
  DEFERRED_INSTRUCTIONS_RULE,
  DEFERRED_MCP_DISPATCH_RULE,
  DEFERRED_TOOLS_INTRO,
  GOAL_RULE,
  LSP_RULE,
  MCP_DISPATCH_RULE,
  READFILE_OFFSETS_RULE,
  TASK_OUTPUT_RULE,
  TODO_TOOLS_RULE,
  TODO_WRITE_RULE,
  TOOL_SEARCH_DISCOVERY_RULE,
  WEB_FETCH_RULE,
  buildCallableToolsLine,
  buildFileToolPreferenceRule,
  buildShellToolRule,
  buildTeammateMessagingRule,
} from "@/prompt/prompts.js";

export function buildToolGuidance(
  toolNames: readonly string[],
  coordinatorMode = false,
): string {
  const names = [...new Set(toolNames)].sort();
  if (names.length === 0) {
    return "";
  }
  const has = (name: string) => names.includes(name);
  const rules: string[] = [];
  const fileTools = [
    "ReadFile",
    "Grep",
    "Glob",
    "EditFile",
    "WriteFile",
  ].filter(has);
  if (fileTools.length) {
    rules.push(buildFileToolPreferenceRule(fileTools));
  }
  if (has("ReadFile")) {
    rules.push(READFILE_OFFSETS_RULE);
  }
  const shells = ["Bash", "PowerShell"].filter(has);
  if (shells.length) {
    rules.push(buildShellToolRule(shells, has("Grep") || has("Glob")));
  }
  if (has("TodoWrite")) {
    rules.push(TODO_TOOLS_RULE);
  }
  if (has("Goal")) {
    rules.push(GOAL_RULE);
  }
  if (has("TodoWrite")) {
    rules.push(TODO_WRITE_RULE);
  }
  if (has("TaskOutput")) {
    rules.push(TASK_OUTPUT_RULE);
  }
  if (has("TaskStop")) {
    rules.push(BACKGROUND_TASK_STOP_RULE);
  }
  if (has("LSP")) {
    rules.push(LSP_RULE);
  }
  if (has("WebFetch")) {
    rules.push(WEB_FETCH_RULE);
  }
  if (has("Agent")) {
    rules.push(AGENT_DELEGATION_RULE);
    rules.push(AGENT_ONE_SHOT_RULE);
    if (has("SendMessage")) {
      rules.push(
        buildTeammateMessagingRule(has("TeamCreate"), coordinatorMode),
      );
    }
  }
  if (has("ToolSearch")) {
    rules.push(TOOL_SEARCH_DISCOVERY_RULE);
    if (has("McpCall")) {
      rules.push(MCP_DISPATCH_RULE);
    }
  }
  return [
    TOOL_GUIDANCE_MARKER,
    buildCallableToolsLine(names),
    ...rules.map((rule) => `- ${rule}`),
  ].join("\n");
}

export function buildDeferredToolGuidance(
  deferredNames: readonly string[],
  availableNames: readonly string[],
  dispatch: boolean,
): string {
  if (!availableNames.includes("ToolSearch")) {
    return "";
  }
  const names = [...new Set(deferredNames)]
    .filter(
      (name) =>
        !dispatch ||
        !name.startsWith(MCP_TOOL_PREFIX) ||
        availableNames.includes("McpCall"),
    )
    .sort();
  if (!names.length) {
    return "";
  }
  return [
    DEFERRED_GUIDANCE_MARKER,
    DEFERRED_TOOLS_INTRO,
    dispatch && names.some((name) => name.startsWith(MCP_TOOL_PREFIX))
      ? DEFERRED_MCP_DISPATCH_RULE
      : DEFERRED_INSTRUCTIONS_RULE,
    ...names,
  ].join("\n");
}
