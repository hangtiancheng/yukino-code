import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import z from "zod";

import { withFileSyncLock } from "./file-lock.js";

import { projectKey, yukinoPath } from "@/storage/paths.js";

/** Metadata for a single team member. */
export const TeamMemberEntrySchema = z.object({
  agentId: z.string(),
  name: z.string(),
  agentType: z.string().optional(),
  model: z.string().optional(),
  joinedAt: z.number(),
  worktreePath: z.string().optional(),
  isActive: z.boolean(),
});

export type TeamMemberEntry = z.infer<typeof TeamMemberEntrySchema>;

/**
 * On-disk team configuration, stored at <teamsBaseDir>/<slug>/config.json.
 *
 * The in-memory Member carries a mailbox, cancel callback, and UI state — none of
 * which can be serialized — so what gets persisted is this pure-metadata structure,
 * with both sides correlated by member name.
 *
 * This file serves Leader-side cross-restart continuity: TeamManager.get()
 * hydrates the roster and marks interrupted runtimes inactive.
 */
const TeamFileSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  createdAt: z.number(),
  leaderAgentId: z.string(),
  permissionMode: z.enum([
    "default",
    "acceptEdits",
    "plan",
    "bypassPermissions",
  ]),
  members: z.array(TeamMemberEntrySchema),
});

export type TeamFile = z.infer<typeof TeamFileSchema>;

/**
 * Project-scoped root directory for team data. The canonical cwd is
 * hashed so unrelated projects cannot restore, list, mutate, or delete each
 * other's teams.
 */
export function teamsBaseDir(cwd: string): string {
  return yukinoPath("teams", projectKey(cwd));
}

/**
 * Compresses a team name into a valid directory name: all non-alphanumeric characters
 * are replaced with hyphens and the result is lowercased. This slug is also the
 * canonical identity used by TeamManager, while config.json retains the display name.
 */
export function sanitizeTeamName(name: string): string {
  if (!name.trim()) {
    throw new Error("Team name must not be empty or whitespace.");
  }
  return name.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
}

export function teamDir(cwd: string, name: string): string {
  return join(teamsBaseDir(cwd), sanitizeTeamName(name));
}

/**
 * Lists every team in one project namespace, identified by its (already
 * sanitized) directory name. Returns an empty list when the base dir does
 * not exist. Used to sweep residual teams left behind by previous sessions.
 */
export function listTeamNames(cwd: string): string[] {
  try {
    return readdirSync(teamsBaseDir(cwd), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export function teamConfigPath(cwd: string, name: string): string {
  return join(teamDir(cwd, name), "config.json");
}

/**
 * Reads team configuration. Returns null when the file does not exist or fails to
 * parse/validate, allowing the caller to treat it as "team not found" rather than
 * propagating an exception.
 */
export function readTeamFile(cwd: string, name: string): TeamFile | null {
  return readTeamFileAtPath(teamConfigPath(cwd, name));
}

export function readTeamFileAtPath(path: string): TeamFile | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return TeamFileSchema.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Writes team configuration under the same cross-process lock used by other
 * shared team files. The temporary file is in the destination directory, so
 * rename publishes a complete JSON document atomically to unlocked readers.
 * Persistence remains best-effort for the in-memory team.
 */
export function writeTeamFile(
  cwd: string,
  name: string,
  file: TeamFile,
  removedMembers: string[] = [],
): void {
  const path = teamConfigPath(cwd, name);
  try {
    mkdirSync(dirname(path), { recursive: true });
    withFileSyncLock(path, () => {
      let next = file;
      if (existsSync(path)) {
        try {
          const current = TeamFileSchema.parse(
            JSON.parse(readFileSync(path, "utf-8")),
          );
          const incomingNames = new Set(
            file.members.map((member) => member.name),
          );
          next = {
            ...file,
            members: [
              ...current.members.filter(
                (member) =>
                  !incomingNames.has(member.name) &&
                  !removedMembers.includes(member.name),
              ),
              ...file.members,
            ],
          };
        } catch {
          // Replace malformed state with the complete in-memory snapshot.
        }
      }

      const tmpPath = `${path}.${String(process.pid)}.${randomBytes(8).toString("hex")}.tmp`;
      try {
        writeFileSync(tmpPath, JSON.stringify(next, null, 2), "utf-8");
        renameSync(tmpPath, path);
      } finally {
        rmSync(tmpPath, { force: true });
      }
    });
  } catch {
    // best-effort
  }
}
