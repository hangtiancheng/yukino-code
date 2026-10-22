import {
  FORK_CONTEXT_FULL_MESSAGES,
  FORK_CONTEXT_RECENT_MESSAGES,
} from "@/skills/constants.js";
import type { Skill, SkillHost, SkillForkHost } from "@/skills/index.js";
import {
  buildSkillPrompt,
  SKILL_INSTRUCTIONS,
  wrapParentContext,
} from "@/skills/prompts.js";
import type { ToolContext } from "@/tools/types.js";

export function parseSkillPrompt(
  prompt: string,
): { name: string; directory: string; body: string; args: string } | undefined {
  const prefix = `${SKILL_INSTRUCTIONS}\n\n`;
  if (!prompt.startsWith(prefix)) {
    return undefined;
  }
  const match =
    /^<skill-metadata><name>([^<]+)<\/name><directory>([^<]*)<\/directory><\/skill-metadata>\n\n<skill-body>\n([\s\S]*)\n<\/skill-body>(?:\n\n<skill-arguments>([^<]*)<\/skill-arguments>)?$/u.exec(
      prompt.slice(prefix.length),
    );
  if (!match) {
    return undefined;
  }
  const decode = (text: string) =>
    text
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&amp;", "&");
  return {
    name: decode(match[1] ?? ""),
    directory: decode(match[2] ?? ""),
    body: match[3] ?? "",
    args: decode(match[4] ?? ""),
  };
}

/** Activate once through the host so its existing skill cache and permissions remain authoritative. */
export function runInline(skill: Skill, args: string, host: SkillHost): string {
  const prompt = buildSkillPrompt(skill, args);
  host.activateSkill(skill.meta.name, prompt);
  return prompt;
}

/** Runs a skill in an isolated subagent and returns its result unchanged. */
export async function runFork(
  skill: Skill,
  args: string,
  host: SkillForkHost,
  abortSignal?: AbortSignal,
  context?: ToolContext,
): Promise<string> {
  let prompt = buildSkillPrompt(skill, args);
  const contextMode = skill.meta.forkContext ?? "none";
  if (contextMode !== "none") {
    const context = host.snapshotParentMessages(
      contextMode === "recent"
        ? FORK_CONTEXT_RECENT_MESSAGES
        : FORK_CONTEXT_FULL_MESSAGES,
    );
    prompt = wrapParentContext(context, prompt);
  }

  return context
    ? host.runSubagent(prompt, abortSignal, context)
    : abortSignal
      ? host.runSubagent(prompt, abortSignal)
      : host.runSubagent(prompt);
}
