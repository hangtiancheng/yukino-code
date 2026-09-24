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

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import z from "zod";

import { createChildLogger } from "@/logger/index.js";
import { detectBackend } from "@/teams/backend.js";
import type { TeamManager } from "@/teams/index.js";

const log = createChildLogger({ module: "code-review" });

const CodeReviewMemberSchema = z.object({
  name: z.string(),
  email: z.string(),
  role: z.enum(["reviewer", "lead", "junior", "critic"]),
  expertise: z.array(z.string()),
  active: z.boolean(),
});

export type CodeReviewMember = z.infer<typeof CodeReviewMemberSchema>;

const CodeReviewTeamSchema = z.object({
  name: z.string(),
  members: z.array(CodeReviewMemberSchema),
  createdAt: z.string(),
  lastActive: z.string(),
});

export type CodeReviewTeam = z.infer<typeof CodeReviewTeamSchema>;

export class CodeReviewManager {
  private teams = new Map<string, CodeReviewTeam>();
  private configPath: string;
  private teamManager: TeamManager;
  private workDir: string;

  constructor(workDir: string, teamManager: TeamManager) {
    this.workDir = workDir;
    this.configPath = join(workDir, ".yukino", "code-review-teams.json");
    this.teamManager = teamManager;
    this.loadTeams();
  }

  private loadTeams(): void {
    if (existsSync(this.configPath)) {
      try {
        const data = readFileSync(this.configPath, "utf-8");
        const teams: unknown = JSON.parse(data);
        const parsed = CodeReviewTeamSchema.array().parse(teams);
        for (const team of parsed) {
          this.teams.set(team.name, team);
        }
      } catch (err) {
        log.error({ err }, "code-review operation failed");

        // Start fresh if file is corrupted
      }
    }
  }

  private saveTeams(): void {
    const dir = join(this.workDir, ".yukino");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const teams = [...this.teams.values()];
    writeFileSync(this.configPath, JSON.stringify(teams, null, 2));
  }

  createTeam(
    name: string,
    members: Omit<CodeReviewMember, "active">[],
  ): CodeReviewTeam {
    const team: CodeReviewTeam = {
      name,
      members: members.map((m) => ({ ...m, active: true })),
      createdAt: new Date().toISOString(),
      lastActive: new Date().toISOString(),
    };
    this.teams.set(name, team);
    this.saveTeams();

    // Also create in TeamManager for messaging
    const teamInstance = this.teamManager.create(name, detectBackend());
    for (const member of members) {
      teamInstance.addMember(member.name);
    }

    return team;
  }

  getTeam(name: string): CodeReviewTeam | undefined {
    return this.teams.get(name);
  }

  listTeams(): CodeReviewTeam[] {
    return [...this.teams.values()];
  }

  addMember(teamName: string, member: Omit<CodeReviewMember, "active">): void {
    const team = this.teams.get(teamName);
    if (!team) {
      throw new Error(`Team '${teamName}' not found`);
    }
    team.members.push({ ...member, active: true });
    team.lastActive = new Date().toISOString();
    this.saveTeams();

    const teamInstance = this.teamManager.get(teamName);
    if (teamInstance) {
      teamInstance.addMember(member.name);
    }
  }

  removeMember(teamName: string, memberName: string): void {
    const team = this.teams.get(teamName);
    if (!team) {
      throw new Error(`Team '${teamName}' not found`);
    }
    team.members = team.members.filter((m) => m.name !== memberName);
    team.lastActive = new Date().toISOString();
    this.saveTeams();
  }

  activateMember(teamName: string, memberName: string): void {
    const team = this.teams.get(teamName);
    if (!team) {
      throw new Error(`Team '${teamName}' not found`);
    }
    const member = team.members.find((m) => m.name === memberName);
    if (!member) {
      throw new Error(`Member '${memberName}' not found in team '${teamName}'`);
    }
    member.active = true;
    team.lastActive = new Date().toISOString();
    this.saveTeams();
  }

  deactivateMember(teamName: string, memberName: string): void {
    const team = this.teams.get(teamName);
    if (!team) {
      throw new Error(`Team '${teamName}' not found`);
    }
    const member = team.members.find((m) => m.name === memberName);
    if (!member) {
      throw new Error(`Member '${memberName}' not found in team '${teamName}'`);
    }
    member.active = false;
    team.lastActive = new Date().toISOString();
    this.saveTeams();
  }

  deleteTeam(name: string): void {
    this.teams.delete(name);
    this.saveTeams();
    this.teamManager.delete(name).catch(() => {
      /** noop */
    });
  }

  getActiveReviewers(teamName: string): CodeReviewMember[] {
    const team = this.teams.get(teamName);
    if (!team) {
      throw new Error(`Team '${teamName}' not found`);
    }
    return team.members.filter((m) => m.active && m.role === "reviewer");
  }

  getTeamSummary(teamName: string): string {
    const team = this.teams.get(teamName);
    if (!team) {
      throw new Error(`Team '${teamName}' not found`);
    }
    const activeCount = team.members.filter((m) => m.active).length;
    const reviewers = team.members.filter((m) => m.role === "reviewer").length;
    const leads = team.members.filter((m) => m.role === "lead").length;

    return (
      `Team: ${team.name}\n` +
      `Members: ${String(activeCount)}/${String(team.members.length)} active\n` +
      `Reviewers: ${String(reviewers)}, Leads: ${String(leads)}\n` +
      `Created: ${new Date(team.createdAt).toLocaleString()}\n` +
      `Last active: ${new Date(team.lastActive).toLocaleString()}`
    );
  }
}

export function createDefaultCodeReviewTeam(): CodeReviewTeam {
  return {
    name: "default-review",
    members: [
      {
        name: "backend",
        email: "backend@yukino.dev",
        role: "lead",
        expertise: ["architecture", "performance", "security"],
        active: true,
      },
      {
        name: "test",
        email: "test@yukino.dev",
        role: "reviewer",
        expertise: ["code-quality", "documentation", "testing"],
        active: true,
      },
      {
        name: "frontend",
        email: "frontend@yukino.dev",
        role: "reviewer",
        expertise: ["frontend", "design", "UI", "UX"],
        active: true,
      },
    ],
    createdAt: new Date().toISOString(),
    lastActive: new Date().toISOString(),
  };
}
