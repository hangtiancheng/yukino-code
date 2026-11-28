import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import z, { parse } from "zod";

import { createChildLogger } from "@/logger/index.js";
import { yukinoPath } from "@/storage/index.js";
import {
  AGENT_FILE_EXTENSION,
  SUBAGENT_AGENTS_DIR_NAME,
  BUILTIN_AGENTS,
  MAX_FALLBACK_DESCRIPTION_CHARS,
} from "@/subagent/constants.js";
import type { AgentDefinition } from "@/subagent/definition.js";
import { parseYamlFrontmatter } from "@/utils/frontmatter.js";

const log = createChildLogger({ module: "subagent" });

/** User definitions override built-in agents. */
export function loadAgentDefinitions(): AgentDefinition[] {
  const definitions = [...BUILTIN_AGENTS];

  loadDir(yukinoPath(SUBAGENT_AGENTS_DIR_NAME), definitions);
  return definitions;
}

/** Scans all .md files in a directory and parses them into Agent definitions, overriding duplicates */
function loadDir(dir: string, definitions: AgentDefinition[]): void {
  if (!existsSync(dir)) {
    return;
  }

  const files = readdirSync(dir).filter((f) =>
    f.endsWith(AGENT_FILE_EXTENSION),
  );
  for (const file of files) {
    try {
      const content = readFileSync(join(dir, file), "utf-8");
      const def = parseAgentDefinition(content);
      if (def) {
        const existing = definitions.findIndex((d) => d.name === def.name);
        if (existing >= 0) {
          definitions[existing] = def;
        } else {
          definitions.push(def);
        }
      }
    } catch (err) {
      log.error({ err }, "subagent operation failed");
      continue;
    }
  }
}

const YamlFrontmatterSchema = z.looseObject({
  name: z.string().trim().min(1),
  description: z.string().optional(),
  tools: z.array(z.string()).optional(),
  disallowed_tools: z.array(z.string()).optional(),
  system_prompt: z.string().optional(),
  max_turns: z.number().int().positive().optional(),
  model: z.string().optional(),
  permission_mode: z
    .enum(["default", "acceptEdits", "plan", "bypassPermissions"])
    .optional(),
  background: z.boolean().optional(),
  worktree: z.boolean().optional(),
});

function parseAgentDefinition(content: string): AgentDefinition | null {
  try {
    const frontmatter = parseYamlFrontmatter(content);
    if (!frontmatter) {
      return null;
    }
    const body = frontmatter.body;
    const parsed = parse(YamlFrontmatterSchema, frontmatter.data);

    return {
      name: parsed.name,
      description:
        parsed.description ?? body.slice(0, MAX_FALLBACK_DESCRIPTION_CHARS),
      tools: parsed.tools,
      disallowedTools: parsed.disallowed_tools,
      systemPromptOverride: parsed.system_prompt,
      maxTurns: parsed.max_turns,
      model: parsed.model,
      permissionMode: parsed.permission_mode,
      background: parsed.background,
      worktree: parsed.worktree,
      initialPrompt: body,
    };
  } catch (err) {
    log.error({ err }, "subagent operation failed");
    return null;
  }
}
