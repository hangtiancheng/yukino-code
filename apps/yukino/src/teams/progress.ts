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

import { z } from "zod";

import { strArg } from "@/utils/index.js";

export const ToolActivitySchema = z.object({
  toolName: z.string(),
  input: z.record(z.string(), z.unknown()),
  activityDescription: z.string(), // e.g. "Reading src/foo.ts"
});
export type ToolActivity = z.infer<typeof ToolActivitySchema>;

export const ActiveToolSchema = z.object({
  toolId: z.string(),
  toolName: z.string(),
});
export type ActiveTool = z.infer<typeof ActiveToolSchema>;

export const AgentProgressSchema = z.object({
  toolUseCount: z.number(),
  turnCount: z.number(),
  tokenCount: z.number(),
  activeTools: z.array(ActiveToolSchema),
  lastActivity: ToolActivitySchema.optional(),
  recentActivities: z.array(ToolActivitySchema), // capped history, max 5 entries
});
export type AgentProgress = z.infer<typeof AgentProgressSchema>;

export const TeammateUIStateSchema = z.object({
  name: z.string(),
  teamName: z.string(),
  status: z.enum(["running", "idle", "completed", "failed", "stopped"]),
  progress: AgentProgressSchema,
  originToolCallId: z.string().optional(),
  startTime: z.number(),
  spinnerVerb: z.string(),
  lastMessage: z.string().optional(),
});

export type TeammateUIState = z.infer<typeof TeammateUIStateSchema>;

export function createProgress(): AgentProgress {
  return {
    toolUseCount: 0,
    turnCount: 0,
    tokenCount: 0,
    activeTools: [],
    lastActivity: undefined,
    recentActivities: [],
  };
}

export function recordToolUse(
  p: AgentProgress,
  toolName: string,
  input: Record<string, unknown>,
): void {
  p.toolUseCount++;
  const activity: ToolActivity = {
    toolName,
    input,
    activityDescription: describeToolActivity(toolName, input),
  };
  p.lastActivity = activity;
  p.recentActivities.push(activity);
  if (p.recentActivities.length > 5) {
    p.recentActivities.shift();
  }
}

// Call this on each tool_use event from the teammate's agent: records the use
// and marks the tool as active until its result arrives.
export function recordToolStart(
  p: AgentProgress,
  toolId: string,
  toolName: string,
  input: Record<string, unknown>,
): void {
  recordToolUse(p, toolName, input);
  p.activeTools = [
    ...p.activeTools.filter((tool) => tool.toolId !== toolId),
    { toolId, toolName },
  ];
}

export function recordToolResult(p: AgentProgress, toolId: string): void {
  p.activeTools = p.activeTools.filter((tool) => tool.toolId !== toolId);
}

export function recordTurnComplete(p: AgentProgress): void {
  p.turnCount++;
  p.activeTools = [];
}

export function clearActiveTools(p: AgentProgress): void {
  p.activeTools = [];
}

// Call this on each usage event
export function recordTokens(
  p: AgentProgress,
  inputTokens: number,
  outputTokens: number,
): void {
  p.tokenCount += inputTokens + outputTokens;
}

function describeToolActivity(
  toolName: string,
  input: Record<string, unknown>,
): string {
  switch (toolName) {
    case "ReadFile":
      return `Reading ${strArg(input, "file_path", "file")}`;
    case "EditFile":
      return `Editing ${strArg(input, "file_path", "file")}`;
    case "WriteFile":
      return `Writing ${strArg(input, "file_path", "file")}`;
    case "Bash":
    case "PowerShell": {
      const cmd = strArg(input, "command", "");
      return `Running ${cmd.length > 40 ? cmd.slice(0, 40) + "..." : cmd}`;
    }
    case "Glob":
      return `Searching ${strArg(input, "pattern", "files")}`;
    case "Grep":
      return `Grepping ${strArg(input, "pattern", "pattern")}`;
    case "WebFetch":
      return `Fetching ${strArg(input, "url", "page")}`;
    default:
      return toolName;
  }
}

// Returns only the most recent activity's description for display.
export function summarizeActivities(activities: ToolActivity[]): string {
  if (!activities.length) {
    return "";
  }
  return activities[activities.length - 1].activityDescription;
}

export function formatTokens(n: number): string {
  if (n >= 1000000) {
    return (n / 1000000).toFixed(1) + "M";
  }
  if (n >= 1000) {
    return (n / 1000).toFixed(1) + "k";
  }
  return String(n);
}
