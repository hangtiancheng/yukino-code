import {
  readdirSync,
  readFileSync,
  existsSync,
  statSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import yaml from "js-yaml";
import { z } from "zod";

import type { Skill, SkillMeta } from "./index.js";

import { createChildLogger } from "@/logger/index.js";
import { yukinoPath } from "@/storage/paths.js";
import { asRecord, strArg } from "@/utils/index.js";

const log = createChildLogger({ module: "skills" });

/**
 * Internal skill storage with the source file path and the file mtime
 * recorded at load time, both used for hot reloading.
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
  private cwd = "";
  private dirModTimes = new Map<string, number | null>();

  load(cwd: string): void {
    this.cwd = cwd;
    this.entries.clear();
    this.dirModTimes.clear();

    for (const dir of this.skillDirPaths()) {
      if (!existsSync(dir)) {
        continue;
      }

      this.scanDirectory(dir, new Set());
    }

    this.snapshotDirModTimes();
  }

  /**
   * Check whether a watched directory mtime has changed (a skill directory or
   * an entry inside one was added or removed). Content edits to existing files
   * do not change directory mtimes; they are handled by lazy re-reading in get().
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
    this.load(this.cwd);
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
    return [
      join(homedir(), ".agents", "skills"),
      yukinoPath("skills"),
      ...(this.cwd ? [join(this.cwd, ".agents", "skills")] : []),
    ];
  }

  private scanDirectory(dir: string, visited: Set<string>) {
    let dirEntries: string[];
    try {
      const canonical = realpathSync(dir);
      if (visited.has(canonical)) {
        return;
      }
      visited.add(canonical);
      this.dirModTimes.set(dir, statSync(dir).mtimeMs);
      const skillFile = join(dir, "SKILL.md");
      if (existsSync(skillFile)) {
        this.loadSkill(skillFile, dir);
        return;
      }
      dirEntries = readdirSync(dir).sort();
    } catch (err) {
      log.error({ err }, "skills operation failed");
      return;
    }

    for (const entry of dirEntries) {
      const fullPath = join(dir, entry);
      if (
        (entry.startsWith(".") || entry === "node_modules") &&
        !existsSync(join(fullPath, "SKILL.md"))
      ) {
        continue;
      }
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          this.scanDirectory(fullPath, visited);
        }
      } catch (err) {
        // A broken symlink or a concurrently removed entry must not hide other skills.
        log.error({ err }, "skills operation failed");
      }
    }
  }
  private loadSkill(filePath: string, sourceDir: string) {
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
      };

      let mtimeMs = 0;
      try {
        mtimeMs = statSync(filePath).mtimeMs;
      } catch (err) {
        log.error({ err }, "skills operation failed");
      }

      this.entries.set(skill.meta.name, {
        skill,
        filePath,
        loadedMtimeMs: mtimeMs,
      });
    } catch (err) {
      log.error({ err }, "skills operation failed");
    }
  }

  list(): SkillMeta[] {
    return [...this.entries.values()].map((e) => e.skill.meta);
  }

  /**
   * Gets a skill with hot reload support: re-reads the file only when its mtime
   * shows it has been modified on disk, and retains the cached body if reading
   * or parsing fails.
   */
  get(name: string): Skill | undefined {
    const entry = this.entries.get(name);
    if (!entry) {
      return undefined;
    }

    if (entry.filePath && entry.loadedMtimeMs > 0) {
      try {
        const currentMtime = statSync(entry.filePath).mtimeMs;
        if (currentMtime !== entry.loadedMtimeMs) {
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
            };
            entry.loadedMtimeMs = currentMtime;
          }
          // Retain the cached version if parsing fails — a single bad write should not cause a skill to vanish
        }
      } catch (err) {
        log.error({ err }, "skills operation failed");
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
  const mode = strArg(asRecord(raw), "mode");
  if (mode === "inline" || mode === "fork") {
    return mode;
  }
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
export function buildSkillSection(catalog: SkillCatalog): string {
  const metas = catalog.list();
  if (metas.length === 0) {
    return "";
  }
  const skillsDir = yukinoPath("skills");
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
