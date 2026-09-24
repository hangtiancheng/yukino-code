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

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import yaml from "js-yaml";
import { z } from "zod";

import type { Skill, SkillMeta } from "./index.js";

import { createChildLogger } from "@/logger/index.js";
import { asRecord, strArg } from "@/utils/index.js";

const log = createChildLogger({ module: "skills" });

/**
 * Internal skill storage with source file path and load timestamp for hot reloading
 *
 */
interface CatalogEntry {
  skill: Skill;
  /** Absolute path to SKILL.md, used for re-reading during hot reloading */
  filePath: string;

  /** File modification time (ms) when last loaded. 0 means the mtime could not be read, so hot reloading is skipped */
  loadedMtimeMs: number;
}

export class SkillCatalog {
  private entries = new Map<string, CatalogEntry>();
  private workDir = "";
  private dirModTimes = new Map<string, number | null>();

  load(workDir: string): void {
    this.workDir = workDir;
    this.entries.clear();
    this.dirModTimes.clear();

    // User-global ~/.agents/skills/, then project-level
    // $workDir/.agents/skills/ (highest priority)
    for (const dir of this.skillDirPaths()) {
      if (!existsSync(dir)) {
        continue;
      }

      this.scanDirectory(dir);
    }

    this.snapshotDirModTimes();
  }

  /**
   * Check whether a skill directory mtime has changed (a skill was added or deleted).
   * Edits to existing skill files are handled by lazy re-reading in get().
   */
  needsReload(): boolean {
    for (const [dir, recorded] of this.dirModTimes) {
      try {
        const current = statSync(dir).mtimeMs;
        if (current !== recorded) {
          return true;
        }
      } catch {
        if (recorded !== null) {
          return true;
        }
      }
    }
    return false;
  }

  reload(): void {
    this.load(this.workDir);
  }

  private snapshotDirModTimes(): void {
    // Watch each skill directory too: adding/removing SKILL.md does not change
    // the parent skills directory's mtime.
    for (const dir of new Set([
      ...this.skillDirPaths(),
      ...this.dirModTimes.keys(),
    ])) {
      try {
        this.dirModTimes.set(dir, statSync(dir).mtimeMs);
      } catch {
        this.dirModTimes.set(dir, null);
      }
    }
  }

  private skillDirPaths(): string[] {
    return [homedir(), ...(this.workDir ? [this.workDir] : [])].flatMap(
      (root) => [".agents"].map((ecosystem) => join(root, ecosystem, "skills")),
    );
  }

  private scanDirectory(dir: string) {
    let dirEntries: string[];
    try {
      dirEntries = readdirSync(dir);
    } catch (err) {
      log.error({ err }, "skills operation failed");
      return;
    }

    for (const entry of dirEntries) {
      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          this.dirModTimes.set(fullPath, stat.mtimeMs);
          const skillFile = join(fullPath, "SKILL.md");
          if (existsSync(skillFile)) {
            this.loadSkill(skillFile, fullPath, true);
          }
        }
      } catch (err) {
        // A broken symlink or a concurrently removed entry must not hide other skills.
        log.error({ err }, "skills operation failed");
      }
      // else if (entry.endsWith(".md") && entry !== "SKILL.md") {
      //   this.loadSkill(fullPath, dir, false);
      // }
    }
  }
  private loadSkill(filePath: string, sourceDir: string, isDirectory: boolean) {
    try {
      const raw = readFileSync(filePath, "utf-8");
      const parsed = parseSkillFile(raw);
      if (!parsed) {
        return;
      }

      const skill: Skill = {
        meta: parsed.meta,
        body: parsed.body,
        sourceDir,
        isDirectory,
      };

      // Record file modification time for subsequent hot reload detection
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(filePath).mtimeMs;
      } catch (err) {
        log.error({ err }, "skills operation failed");
        // Fail gracefully if timestamp cannot be retrieved
      }

      this.entries.set(skill.meta.name, {
        skill,
        filePath,
        loadedMtimeMs: mtimeMs,
      });
    } catch (err) {
      log.error({ err }, "skills operation failed");
      // Skip invalid skill
    }
  }

  list(): SkillMeta[] {
    return [...this.entries.values()].map((e) => e.skill.meta);
  }

  /**
   * Gets a skill with hot reload support: automatically re-reads the file if it has been modified on disk.
   * re-reads the body on every call (hot reload),
   * and retains the cached body if reading fails.
   */
  get(name: string): Skill | undefined {
    const entry = this.entries.get(name);
    if (!entry) {
      return undefined;
    }

    // Attempt hot reload: check if the file has been modified
    if (entry.filePath && entry.loadedMtimeMs > 0) {
      try {
        const currentMtime = statSync(entry.filePath).mtimeMs;
        if (currentMtime !== entry.loadedMtimeMs) {
          // File has been modified, re-read it
          const raw = readFileSync(entry.filePath, "utf-8");
          const parsed = parseSkillFile(raw);
          if (parsed) {
            if (parsed.meta.name !== name) {
              // Rebuild indexes and precedence when frontmatter renames a skill.
              this.reload();
              return this.entries.get(name)?.skill;
            }
            entry.skill = {
              meta: parsed.meta,
              body: parsed.body,
              sourceDir: entry.skill.sourceDir,
              isDirectory: entry.skill.isDirectory,
            };
            entry.loadedMtimeMs = currentMtime;
          }
          // Retain the cached version if parsing fails — a single bad write should not cause a skill to vanish
        }
      } catch (err) {
        log.error({ err }, "skills operation failed");
        // Retain the cached version if reading fails
      }
    }

    return entry.skill;
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }
}

/**
 * Normalize the execution mode.
 *
 * Some agent ecosystems use `context: fork` to express "isolated execution", which is
 * semantically equivalent to `mode: fork` here. Both forms are interchangeable, so
 * externally sourced skills work without modification.
 */
function resolveMode(raw: unknown): "inline" | "fork" {
  // raw.mode
  const mode = strArg(asRecord(raw), "mode");
  if (mode === "inline" || mode === "fork") {
    return mode;
  }
  // raw.context
  return strArg(asRecord(raw), "context") === "fork" ? "fork" : "inline";
}

const YamlFrontmatterSchema = z.looseObject({
  name: z.string().trim().min(1),
  description: z.string().optional(),
  mode: z.enum(["inline", "fork"]).optional(),
  model: z.string().optional(),
  fork_context: z.enum(["full", "none", "recent"]).optional(),
});

export function parseSkillFile(content: string): {
  meta: SkillMeta;
  body: string;
  frontmatter: Record<string, unknown>;
} | null {
  // Delimiters occupy their own lines; `---` inside YAML strings is content.
  const normalized = content.replace(/^\uFEFF/, "");
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(
    normalized,
  );
  if (!match) {
    return null;
  }
  const body = normalized.slice(match[0].length).trim();

  try {
    const raw: unknown = yaml.load(match[1]);
    const data = YamlFrontmatterSchema.parse(raw);
    return {
      meta: {
        name: data.name,
        description: data.description ?? "",
        mode: resolveMode(raw),
        model: data.model,
        forkContext: data.fork_context,
      },
      body,
      frontmatter: data,
    };
  } catch (err) {
    log.error({ err }, "skills operation failed");
    return null;
  }
}

export function escapeSkillXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** Metadata-only conversation reminder; bodies load on demand without changing the system prefix. */
export function buildSkillSection(
  catalog: SkillCatalog,
  workDir: string,
): string {
  const metas = catalog.list();
  if (metas.length === 0) {
    return "";
  }
  const skillsDir = join(workDir, ".agents", "skills");
  const lines = [
    "## Skills",
    'Load relevant instructions with LoadSkill {name: "<skill-name>"}, or user command /<skill-name>. Mode inline activates in this conversation; fork runs in a subagent when available, otherwise inline. Load resources only as needed, relative to the skill directory. Tool access remains host-controlled.',
    'InstallSkill {source: "<local path or raw SKILL.md URL>"} makes skills available immediately. skills.sh pages and GitHub tree/blob pages are not supported.',
    "Create skills under the following directory as <skill-name>/SKILL.md:",
    `<skills-directory>${escapeSkillXml(skillsDir)}</skills-directory>`,
    "<available-skills>",
  ];
  for (const meta of metas) {
    const oneLine = meta.description.replace(/\s+/g, " ").trim();
    const desc = oneLine.length > 200 ? oneLine.slice(0, 200) + "…" : oneLine;
    lines.push(
      `<skill><name>${escapeSkillXml(meta.name)}</name><description>${escapeSkillXml(desc)}</description><mode>${meta.mode ?? "inline"}</mode></skill>`,
    );
  }
  lines.push("</available-skills>");
  return lines.join("\n");
}
