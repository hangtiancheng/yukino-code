import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import z from "zod";

import { withFileSyncLock } from "./file-lock.js";

import { canonicalPath } from "@/utils/paths.js";

/** Metadata for a single team member. */
export const TeamMemberEntrySchema = z.object({
  agentId: z.string(),
  name: z.string(),
  agentType: z.string().optional(),
  model: z.string().optional(),
  joinedAt: z.number(),
  worktreePath: z.string().optional(),
  backendType: z.enum(["in-process", "tmux", "iterm"]),
  paneId: z.string().optional(),
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
 * hydrates the roster and recreates runtime UI/stop handles for active members.
 * Pane teammates read it for leader liveness (leaderPid): a teammate whose
 * leader has been gone for a sustained period exits instead of polling forever.
 * Teammates receive the team name, member name, and mailbox directory via
 * command-line flags at spawn.
 */
const TeamFileSchema = z.object({
  name: z.string(),
  mode: z.enum(["in-process", "tmux", "iterm"]),
  description: z.string().optional(),
  createdAt: z.number(),
  leaderAgentId: z.string(),
  /** PID of the process currently acting as leader; written by leader-side TeamManager.get()/create(). */
  leaderPid: z.number().optional(),
  members: z.array(TeamMemberEntrySchema),
});

export type TeamFile = z.infer<typeof TeamFileSchema>;

/**
 * Project-scoped root directory for team data. The canonical work directory is
 * hashed so unrelated projects cannot restore, list, mutate, or delete each
 * other's teams while pane teammates can still use a home-anchored path.
 */
export function teamsBaseDir(workDir: string): string {
  const namespace = createHash("sha256")
    .update(canonicalPath(workDir))
    .digest("hex");
  return join(homedir(), ".yukino", "teams", namespace);
}

/**
 * Compresses a team name into a valid directory name: all non-alphanumeric characters
 * are replaced with hyphens and the result is lowercased. This slug is also the
 * canonical identity used by TeamManager, while config.json retains the display name.
 */
export function sanitizeTeamName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
}

export function teamDir(workDir: string, name: string): string {
  return join(teamsBaseDir(workDir), sanitizeTeamName(name));
}

/**
 * Lists every team in one project namespace, identified by its (already
 * sanitized) directory name. Returns an empty list when the base dir does
 * not exist. Used to sweep residual teams left behind by previous sessions.
 */
export function listTeamNames(workDir: string): string[] {
  try {
    return readdirSync(teamsBaseDir(workDir), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export function teamConfigPath(workDir: string, name: string): string {
  return join(teamDir(workDir, name), "config.json");
}

/**
 * Reads team configuration. Returns null when the file does not exist or fails to
 * parse/validate, allowing the caller to treat it as "team not found" rather than
 * propagating an exception.
 */
export function readTeamFile(workDir: string, name: string): TeamFile | null {
  const path = teamConfigPath(workDir, name);
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
  workDir: string,
  name: string,
  file: TeamFile,
): void {
  const path = teamConfigPath(workDir, name);
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
                (member) => !incomingNames.has(member.name),
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
