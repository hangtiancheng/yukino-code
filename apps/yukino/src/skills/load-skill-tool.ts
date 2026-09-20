/**
 * Copyright (c) 2026 hangtiancheng
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

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
// conversation as a regular message (progressive disclosure).
export class LoadSkillTool implements Tool {
  name = "LoadSkill";
  description =
    "Activate a skill by name. Returns the full SOP body so you can follow its instructions.. Call this when the user's request matches one of the available " +
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

    // Fork mode: the SOP body does not enter the main conversation; it is delegated to an
    // isolated subagent for execution, and only the final result is returned. This ensures
    // that model-initiated skill loading and user-invoked slash commands follow the same mode
    // semantics — the declared isolation intent takes effect on both paths.
    if (skill.meta.mode === "fork" && this.forkHost) {
      try {
        return {
          output: await runFork(skill, "", this.forkHost),
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
