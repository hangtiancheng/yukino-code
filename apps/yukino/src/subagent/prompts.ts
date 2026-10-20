import type { AgentDefinition } from "@/subagent/definition.js";

export const AGENT_TOOL_DESCRIPTION =
  "Launch a subagent to handle complex, multi-step tasks.";

export const PLAN_AGENT_PROMPT =
  "Use the inherited conversation to investigate the user's current task and return a concrete implementation plan with relevant files, constraints, verification steps, and unresolved questions. Do not modify files. Return the complete plan directly; the parent host will save it and request user approval.";

export const INHERITED_TOOL_RESULT =
  "This tool call is running in the parent agent. Continue with the assigned task using the inherited context.";

export const SUBAGENT_TYPE_DESCRIPTION =
  "Agent role. Defaults to general-purpose, independently of fork.";
export const FORK_PARAMETER_DESCRIPTION =
  "Copy the parent conversation when true; start a fresh conversation when false. Independent of subagent_type. Defaults to the session's enable_fork setting (true when unset).";

export function buildAgentToolDescription(
  definitions: AgentDefinition[],
  defaultFork: boolean,
): string {
  const roles = definitions.map(
    (definition) => `- ${definition.name}: ${definition.description}`,
  );
  return `Delegate a bounded task to a subagent. subagent_type selects the role (default general-purpose); fork independently selects whether to inherit a snapshot of the parent conversation (default ${String(defaultFork)}). Any role can use either context mode. With fork=false, include the goal, relevant files, constraints, whether edits are allowed, and the expected result.

Available roles (pass a role as subagent_type, not as a tool name):
${roles.join("\n")}

Foreground calls return results inline. With run_in_background=true, the call returns a task ID immediately and the final result arrives through a task notification. Use team_name for persistent teammates and SendMessage for their follow-up assignments. The fork setting seeds a teammate's initial conversation only. Do not predict results before receiving them.
Role tool restrictions and max_turns apply equally with fork=true and fork=false. Roles have no default model-turn limit; max_turns supplies an explicit limit. Reaching a limit is unfinished work, not successful task completion.

Launch independent tasks together; avoid concurrent writes to the same files. Review returned evidence and integrate it before reporting completion. Worktree isolation separates edits but does not merge them.`;
}
