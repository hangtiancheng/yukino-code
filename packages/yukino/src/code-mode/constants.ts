export const CODE_MODE_TOOL_NAME = "CodeMode";
export const CODE_MODE_RECORD = "code-mode";
export const CODE_MODE_RECOVERY_RECORD = "code-mode-recovery";
export const CODE_MODE_VERSION = 3;
export const VM_LANE_CAPACITY = Object.freeze({
  codemode: 2,
  workflowRoot: 1,
  workflowChild: 1,
});
export const VM_MAX_PENDING_CALLS = 64;
export const VM_MAX_DECLARATION_CHARS = 2 * 1024 * 1024;
export const VM_MAX_DECLARATIONS = 2000;
export const VM_MAX_SOURCE_CHARS = 1024 * 1024;
export const VM_MAX_JSON_DEPTH = 32;
export const VM_MAX_JSON_NODES = 20_000;
export const VM_STACK_BYTES = 256 * 1024;
export const VM_JOBS_PER_BATCH = 50;
export const CODE_MODE_MEMORY_BYTES = 256 * 1024 * 1024;
export const CODE_MODE_TIMEOUT_MS = 300_000;
export const CODE_MODE_MAX_WORKERS = 2;
export const CODE_MODE_MAX_OUTPUT_TOKENS = 10_000;
export const CODE_MODE_MAX_OUTPUT_CHARS = 16 * 1024 * 1024;
export const CODE_MODE_MAX_OUTPUT_ITEMS = 100_000;
export const CODE_MODE_MAX_STORE_CHARS = 1024 * 1024;
export const CODE_MODE_MAX_STORE_VALUE_CHARS = 256 * 1024;
export const CODE_MODE_MAX_CALLS = 1000;
export const CODE_MODE_INLINE_CHARS = 12_000;
export const CODE_MODE_EXCLUDED_TOOLS = new Set([
  CODE_MODE_TOOL_NAME,
  "Agent",
  "Workflow",
  "TaskOutput",
  "LoadSkill",
  "EnterPlanMode",
  "ExitPlanMode",
  "EnterWorktree",
  "ExitWorktree",
]);
