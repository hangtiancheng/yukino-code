import {
  ACTIONS_PROMPT,
  GUIDELINES_PROMPT,
  IDENTITY_PROMPT,
  STYLE_PROMPT,
  SYSTEM_PROMPT,
  TOOLS_PROMPT,
  UPDATES_PROMPT,
} from "@/prompt/prompts.js";

export interface Section {
  name: string;
  content: string;
}

export function identitySection(): Section {
  return {
    name: "Identity",
    content: IDENTITY_PROMPT,
  };
}

export function systemSection(): Section {
  return {
    name: "System",
    content: SYSTEM_PROMPT,
  };
}

export function doingTasksSection(): Section {
  return {
    name: "DoingTasks",
    content: GUIDELINES_PROMPT,
  };
}

export function executingActionsSection(): Section {
  return {
    name: "ExecutingActions",
    content: ACTIONS_PROMPT,
  };
}

export function usingToolsSection(): Section {
  return {
    name: "UsingTools",
    content: TOOLS_PROMPT,
  };
}

export function toneStyleSection(): Section {
  return {
    name: "ToneStyle",
    content: STYLE_PROMPT,
  };
}

export function outputEfficiencySection(): Section {
  return {
    name: "TextOutput",
    content: UPDATES_PROMPT,
  };
}

export interface EnvironmentContext {
  cwd: string;
  os: string;
  arch: string;
  shell: string;
  isGitRepo: boolean;
  gitBranch: string;
  model: string;
  date: string;
}

export function environmentSection(env: EnvironmentContext): Section {
  const lines = [
    "# Environment",
    ` - Working directory: ${env.cwd}`,
    ` - Platform: ${env.os}/${env.arch}`,
    ` - Shell: ${env.shell}`,
    ` - Git repository: ${env.isGitRepo ? "true" : "false"}`,
  ];
  if (env.isGitRepo && env.gitBranch) {
    lines.push(` - Git branch: ${env.gitBranch}`);
  }
  if (env.model) {
    lines.push(` - Model: ${env.model}`);
  }
  lines.push(` - Date: ${env.date}`);
  return {
    name: "Environment",
    content: lines.join("\n"),
  };
}
