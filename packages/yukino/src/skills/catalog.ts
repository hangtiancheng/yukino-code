import { createHash } from "node:crypto";
import {
  readdirSync,
  readFileSync,
  existsSync,
  statSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { createChildLogger } from "@/logger/index.js";
import {
  SKILLS_AGENTS_DIR_NAME,
  SKILL_FILE_NAME,
  SKILLS_DIR_NAME,
} from "@/skills/constants.js";
import type { Skill, SkillMeta } from "@/skills/types.js";
import { yukinoPath } from "@/storage/index.js";
import { parseYamlFrontmatter } from "@/utils/frontmatter.js";
import { asRecord, strArg } from "@/utils/index.js";
import { isPathWithin } from "@/utils/paths.js";
import { projectAncestorDirs } from "@/utils/paths.js";

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

export interface SkillCatalogOptions {
  projectFileDigests?: ReadonlyMap<string, string>;
  projectPaths?: readonly string[];
  additionalPaths?: readonly string[];
  disabled?: readonly string[];
}

export class SkillCatalog {
  private approved(filePath: string, raw: string): boolean {
    return (
      !this.options.projectFileDigests ||
      !this.options.projectPaths?.some((root) =>
        isPathWithin(root, filePath),
      ) ||
      this.options.projectFileDigests.get(filePath) ===
        createHash("sha256").update(raw).digest("hex")
    );
  }
  private options: SkillCatalogOptions = {};
  private entries = new Map<string, CatalogEntry>();
  private cwd = "";
  private dirModTimes = new Map<string, number | null>();

  load(cwd: string, options: SkillCatalogOptions = {}): void {
    this.options = structuredClone(options);
    this.cwd = cwd;
    this.entries.clear();
    this.dirModTimes.clear();

    for (const dir of this.skillDirPaths()) {
      if (!existsSync(dir)) {
        continue;
      }

      this.scanDirectory(dir, new Set());
    }

    for (const [name, entry] of this.entries) {
      if (
        options.disabled?.some(
          (value) =>
            value === name ||
            value === entry.filePath ||
            value === entry.skill.sourceDir,
        )
      ) {
        this.entries.delete(name);
      }
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
    this.load(this.cwd, this.options);
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
      join(homedir(), SKILLS_AGENTS_DIR_NAME, SKILLS_DIR_NAME),
      yukinoPath(SKILLS_DIR_NAME),
      ...(this.options.additionalPaths ?? []),
      ...(this.options.projectPaths ??
        (this.cwd
          ? projectAncestorDirs(this.cwd).map((dir) =>
              join(dir, SKILLS_AGENTS_DIR_NAME, SKILLS_DIR_NAME),
            )
          : [])),
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
      const skillFile = join(dir, SKILL_FILE_NAME);
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
        !existsSync(join(fullPath, SKILL_FILE_NAME))
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
  private statMtime(filePath: string): number {
    try {
      return statSync(filePath).mtimeMs;
    } catch (err) {
      log.error({ err }, "skills operation failed");
      return 0;
    }
  }

  private loadSkill(filePath: string, sourceDir: string) {
    try {
      // Stat before reading so the cached stamp never claims a version newer
      // than the body we hold; otherwise get() would treat stale content as
      // fresh. Re-stat after the read: if the file changed mid-read the stamps
      // differ, and keeping the pre-read stamp forces a reload on next access.
      const mtimeBefore = this.statMtime(filePath);
      const raw = readFileSync(filePath, "utf-8");
      if (!this.approved(filePath, raw)) {
        return;
      }
      const parsed = parseSkillFile(raw);
      if (!parsed) {
        return;
      }
      const mtimeAfter = this.statMtime(filePath);
      if (mtimeBefore !== mtimeAfter) {
        log.debug(
          { filePath },
          "skill file changed during load; will reload on next access",
        );
      }

      const skill: Skill = {
        meta: parsed.meta,
        body: parsed.body,
        sourceDir,
      };

      this.entries.set(skill.meta.name, {
        skill,
        filePath,
        loadedMtimeMs: mtimeBefore,
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
          if (!this.approved(entry.filePath, raw)) {
            return entry.skill;
          }
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
  try {
    const frontmatter = parseYamlFrontmatter(content);
    if (!frontmatter) {
      return null;
    }
    const body = frontmatter.body;
    const raw = frontmatter.data;
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
