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

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import yaml from "js-yaml";
import z, { parse } from "zod";

import { BUILTIN_AGENTS, type AgentDefinition } from "./definition.js";

import { createChildLogger } from "@/logger/index.js";

const log = createChildLogger({ module: "subagent" });

/**
 * Loads Agent definitions in order: built-in → user-level (~/.yukino/agents/) → project-level (.yukino/agents/).
 * Later definitions with the same name override earlier ones. Priority: project > user > built-in.
 */
export function loadAgentDefinitions(workDir: string): AgentDefinition[] {
  const definitions = [...BUILTIN_AGENTS];

  // User-level directory: ~/.yukino/agents/
  const home = homedir();
  if (home) {
    loadDir(join(home, ".yukino", "agents"), definitions);
  }

  // Project-level directory: <workDir>/.yukino/agents/
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

const YamlFrontmatterSchema = z.looseObject({
  name: z.string(),
  description: z.string().optional(),
  tools: z.array(z.string()).optional(),
  disallowed_tools: z.array(z.string()).optional(),
  system_prompt: z.string().optional(),
  max_turns: z.number().optional(),
  model: z.string().optional(),
  background: z.boolean().optional(),
  isolation: z.literal("worktree").optional(),
});

function parseAgentDefinition(content: string): AgentDefinition | null {
  if (!content.startsWith("---")) {
    return null;
  }
  const endIdx = content.indexOf("---", 3);
  if (endIdx === -1) {
    return null;
  }

  const frontmatter = content.slice(3, endIdx).trim();
  const body = content.slice(endIdx + 3).trim();

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
      background: parsed.background,
      isolation: parsed.isolation,
      initialPrompt: body,
    };
  } catch (err) {
    log.error({ err }, "subagent operation failed");
    return null;
  }
}
