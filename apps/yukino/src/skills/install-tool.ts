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

import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  lstatSync,
  realpathSync,
  openSync,
  closeSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";

import yaml from "js-yaml";

import { parseSkillFile, type SkillCatalog } from "./catalog.js";

import { createChildLogger } from "@/logger/index.js";
import type {
  Tool,
  ToolContext,
  ToolResult,
  ToolSchema,
} from "@/tools/types.js";
import { asErrorString, strArg } from "@/utils/index.js";

const log = createChildLogger({ module: "skills" });

// Installs a skill from a local file path or an https URL into
// .agents/skills/<name>/SKILL.md, then reloads the catalog.
export class InstallSkillTool implements Tool {
  name = "InstallSkill";
  description =
    "Install a skill from a local file path or an https URL into .agents/skills.";
  category = "write" as const;

  constructor(
    private workDir: string,
    private catalog: SkillCatalog,
    private onInstalled?: () => void,
  ) {}

  schema(): ToolSchema {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          source: {
            type: "string",
            description:
              "Local file path or raw SKILL.md URL (not an HTML or repository page)",
          },
          name: {
            type: "string",
            description:
              "Optional skill name override; letters, digits, dots, underscores and hyphens",
          },
        },
        required: ["source"],
      },
    };
  }

  async execute(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const source = strArg(args, "source");
    if (!source) {
      return { output: "Error: source is required", isError: true };
    }

    try {
      ctx.abortSignal?.throwIfAborted();
      let content: string;
      if (/^https?:\/\//i.test(source)) {
        const timeout = new AbortController();
        const timer = setTimeout(() => {
          timeout.abort(
            new DOMException(
              "Skill download timed out after 30 seconds",
              "TimeoutError",
            ),
          );
        }, 30_000);
        timer.unref();
        const signal = ctx.abortSignal
          ? AbortSignal.any([ctx.abortSignal, timeout.signal])
          : timeout.signal;
        try {
          const resp = await fetch(source, { signal });
          if (!resp.ok) {
            return {
              output: `Error: fetch failed (${String(resp.status)})`,
              isError: true,
            };
          }
          content = await resp.text();
          signal.throwIfAborted();
        } finally {
          // Keep the timeout active until the response body has been consumed.
          clearTimeout(timer);
        }
      } else {
        content = readFileSync(resolve(this.workDir, source), "utf-8");
      }

      const parsed = parseSkillFile(content);
      if (!parsed) {
        return {
          output:
            "Error: source must be a valid SKILL.md with a frontmatter name",
          isError: true,
        };
      }
      const name = strArg(args, "name") || parsed.meta.name;
      if (!/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(name) || name.endsWith(".")) {
        return {
          output:
            "Error: invalid skill name; use letters, digits, dots, underscores and hyphens",
          isError: true,
        };
      }
      if (name !== parsed.meta.name) {
        // The catalog indexes the YAML name, so an override must update it too.
        content = `---\n${yaml.dump({ ...parsed.frontmatter, name })}---\n\n${parsed.body}\n`;
      }

      ctx.abortSignal?.throwIfAborted();
      // Resolve the workspace itself (which may be reached via a symlink), then
      // reject symlinks in every installation component, including dangling links.
      let dir = realpathSync(this.workDir);
      for (const segment of [".agents", "skills", name]) {
        dir = join(dir, segment);
        const stat = lstatSync(dir, { throwIfNoEntry: false });
        if (stat) {
          if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw new Error(
              `Installation directory must be a real directory: ${dir}`,
            );
          }
        } else {
          mkdirSync(dir);
        }
      }
      const destination = join(dir, "SKILL.md");
      const stat = lstatSync(destination, { throwIfNoEntry: false });
      if (stat && (stat.isSymbolicLink() || !stat.isFile())) {
        throw new Error(
          `Installation target must be a regular file: ${destination}`,
        );
      }

      // Replace only this directory entry. This also avoids truncating a file
      // outside the workspace when the old SKILL.md has another hard link.
      const temporary = join(dir, `.SKILL-${randomUUID()}.tmp`);
      const fd = openSync(temporary, "wx", stat?.mode ?? 0o666);
      try {
        try {
          writeFileSync(fd, content, "utf-8");
        } finally {
          closeSync(fd);
        }
        renameSync(temporary, destination);
      } finally {
        rmSync(temporary, { force: true });
      }

      this.catalog.load(this.workDir);
      this.onInstalled?.();
      return {
        output: `Skill '${name}' installed to .agents/skills/${name}/SKILL.md`,
        isError: false,
      };
    } catch (err) {
      log.error({ err }, "skills operation failed");
      return {
        output: `Error installing skill: ${asErrorString(err)}`,
        isError: true,
      };
    }
  }
}
