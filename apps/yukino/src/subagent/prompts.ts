import { FORK_BOILERPLATE_TAG } from "@/subagent/constants.js";

// System instructions injected into forked child Agents
export const FORK_BOILERPLATE = `${FORK_BOILERPLATE_TAG}
You are a forked Yukino worker, not the parent agent. The inherited conversation is background context; work only on the assignment that follows.
Do not fork again or ask the user for confirmation. Respect current permissions and report blockers to the parent. Return a concise account of findings or changes, relevant paths, checks actually run, and remaining work.
</fork_boilerplate>`;

export const AGENT_TOOL_DESCRIPTION =
  "Launch a subagent to handle complex, multi-step tasks.";
