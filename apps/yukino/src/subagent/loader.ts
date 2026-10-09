import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import yaml from "js-yaml";
import z, { parse } from "zod";

import { BUILTIN_AGENTS, type AgentDefinition } from "./definition.js";

import { createChildLogger } from "@/logger/index.js";
import { yukinoPath } from "@/storage/paths.js";

const log = createChildLogger({ module: "subagent" });

/** User definitions override built-in agents. */
export function loadAgentDefinitions(): AgentDefinition[] {
  const definitions = [...BUILTIN_AGENTS];

  loadDir(yukinoPath("agents"), definitions);
  return definitions;
}

/** Scans all .md files in a directory and parses them into Agent definitions, overriding duplicates */
function loadDir(dir: string, definitions: AgentDefinition[]): void {
  if (!existsSync(dir)) {
    return;
  }

  const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
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
  isolation: z.literal("worktree").optional(),
});

function parseAgentDefinition(content: string): AgentDefinition | null {
  content = content.replace(/^\uFEFF/u, "");
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u.exec(
    content,
  );
  if (!match) {
    return null;
  }

  const frontmatter = match[1].trim();
  const body = content.slice(match[0].length).trim();

  try {
    const raw: unknown = yaml.load(frontmatter);
    const parsed = parse(YamlFrontmatterSchema, raw);

    return {
      name: parsed.name,
      description: parsed.description ?? body.slice(0, 200),
      tools: parsed.tools,
      disallowedTools: parsed.disallowed_tools,
      systemPromptOverride: parsed.system_prompt,
      maxTurns: parsed.max_turns,
      model: parsed.model,
      permissionMode: parsed.permission_mode,
      background: parsed.background,
      isolation: parsed.isolation,
      initialPrompt: body,
    };
  } catch (err) {
    log.error({ err }, "subagent operation failed");
    return null;
  }
}
