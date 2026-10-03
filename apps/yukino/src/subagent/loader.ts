import { readdirSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import yaml from "js-yaml";
import z, { parse } from "zod";

import { BUILTIN_AGENTS, type AgentDefinition } from "./definition.js";

import { createChildLogger } from "@/logger/index.js";
import type { PermissionMode } from "@/permissions/index.js";

const log = createChildLogger({ module: "subagent" });

/**
 * Loads Agent definitions in order: built-in → user-level (~/.yukino/agents/) → project-level (.yukino/agents/).
 * Later definitions with the same name override earlier ones. Priority: project > user > built-in.
 */
export function loadAgentDefinitions(workDir: string): AgentDefinition[] {
  const definitions = [...BUILTIN_AGENTS];

  const home = homedir();
  if (home) {
    loadDir(join(home, ".yukino", "agents"), definitions);
  }

  const dirs = [join(workDir, ".yukino", "agents")];
  for (const dir of dirs) {
    loadDir(dir, definitions);
  }

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

// Frontmatter permission_mode: validated against the real permission modes
// so a typo fails the definition loudly instead of being silently ignored.
const PermissionModeSchema = z.enum([
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
] as const satisfies readonly PermissionMode[]);

const YamlFrontmatterSchema = z.looseObject({
  name: z.string(),
  description: z.string().optional(),
  tools: z.array(z.string()).optional(),
  disallowed_tools: z.array(z.string()).optional(),
  system_prompt: z.string().optional(),
  max_turns: z.number().optional(),
  model: z.string().optional(),
  permission_mode: PermissionModeSchema.optional(),
  background: z.boolean().optional(),
  isolation: z.literal("worktree").optional(),
});

function parseAgentDefinition(content: string): AgentDefinition | null {
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
