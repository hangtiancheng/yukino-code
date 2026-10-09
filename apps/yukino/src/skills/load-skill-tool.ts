import type { SkillCatalog } from "./catalog.js";
import { runFork, runInline } from "./executor.js";

import type { SkillForkHost, SkillHost } from "./index.js";

import type {
  Tool,
  ToolContext,
  ToolResult,
  ToolSchema,
} from "@/tools/types.js";
import { asErrorString, strArg } from "@/utils/index.js";

// On-demand skill activation: returns the full SOP body so it enters the
// conversation as a regular message (progressive disclosure). Fork-mode
// skills instead delegate to a subagent and return only its result.
export class LoadSkillTool implements Tool {
  name = "LoadSkill";
  description =
    "Activate a skill by name. Returns the full SOP body so you can follow its instructions. Call this when the user's request matches one of the available " +
    "Skills listed in the available-skills section. Pass the Skill name without a leading slash.";
  category = "read" as const;

  constructor(
    private catalog: SkillCatalog,
    private host: SkillHost,
    // Host for running isolated subagents; skills with mode: fork depend on it.
    // When omitted (host has not integrated the subagent runtime), falls back to inline
    // to ensure the tool remains available.
    private forkHost?: SkillForkHost,
  ) {}

  forDelegatedAgent(): LoadSkillTool {
    return new LoadSkillTool(this.catalog, { activateSkill: () => undefined });
  }

  schema(): ToolSchema {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Name of the skill to activate",
          },
        },
        required: ["name"],
      },
    };
  }

  async execute(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const name = strArg(args, "name");
    const skill = this.catalog.get(name);
    if (!skill) {
      const available =
        this.catalog
          .list()
          .map((s) => s.name)
          .join(", ") || "(none)";
      return {
        output: `Skill '${name}' not found. Available skills: ${available}`,
        isError: true,
      };
    }

    // Fork mode keeps the SOP body out of the main conversation: an isolated
    // subagent executes it and only its final result is returned.
    if (skill.meta.mode === "fork" && this.forkHost) {
      try {
        return {
          output: await runFork(skill, "", this.forkHost, ctx.abortSignal, ctx),
          isError: false,
        };
      } catch (err) {
        return {
          output: `Skill '${name}' fork execution failed: ${asErrorString(err)}`,
          isError: true,
        };
      }
    }

    const body = runInline(skill, "", this.host);
    return {
      output: `Skill '${name}' activated.\n\n${body}`,
      isError: false,
    };
  }
}
