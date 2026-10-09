import {
  isValidThinkingLevel,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "@/config/provider-config.js";

export type CommandType = "local" | "local_ui" | "prompt" | "skill_fork";

export interface CommandContext {
  cwd: string;
  args: string;
  conversation?: unknown;
  registry?: unknown;
  permissionMode?: () => string;
  /** Returns token usage [input, output] */
  tokenCount?: () => [number, number];
  /** Returns the number of currently enabled tools */
  toolCount?: () => number;
  memoryList?: () => string[];
  model?: string;
  /** Returns the current effective thinking level */
  thinkingLevel?: () => ThinkingLevel;
  /** Returns the active client's available logical thinking levels */
  availableThinkingLevels?: () => readonly ThinkingLevel[];
  /** Sets the thinking level for the active client */
  setThinkingLevel?: (level: ThinkingLevel) => void;
  /** Persists the thinking level to the global config; throws on failure */
  persistThinkingLevel?: (level: ThinkingLevel) => void;
}

export interface Command {
  name: string;
  type: CommandType;
  description: string;
  handler: (ctx: CommandContext) => string;
  /** Skill-derived commands; excluded from the /help listing (see /skills). */
  isSkill?: boolean;
  /** Handler returns markdown to render richly (e.g. a table), not plain text. */
  markdown?: boolean;
}

export class CommandRegistry {
  private commands = new Map<string, Command>();
  /** Throws when the name conflicts with an existing command. */
  register(cmd: Command): void {
    const key = cmd.name.toLowerCase();
    if (this.commands.has(key)) {
      throw new Error(`Command '${cmd.name}' already registered`);
    }
    this.commands.set(key, cmd);
  }

  find(name: string): Command | undefined {
    return this.commands.get(name.toLowerCase());
  }

  complete(prefix: string): Command[] {
    const lower = prefix.toLowerCase();
    return [...this.commands.values()].filter((cmd) =>
      cmd.name.toLowerCase().startsWith(lower),
    );
  }

  listCommands(): Command[] {
    return [...this.commands.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }
}

interface Parsed {
  name: string;
  args: string;
}

export function parse(input: string): Parsed | null {
  if (!input.startsWith("/")) {
    return null;
  }
  const trimmed = input.slice(1).trim();
  const spaceIdx = trimmed.search(/\s/);
  const name = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  // Command names never contain "/"; a slash means the input is a filesystem
  // path (e.g. /path/to/somewhere), which should be a plain user message.
  if (name.includes("/")) {
    return null;
  }
  if (spaceIdx === -1) {
    return { name, args: "" };
  }
  return {
    name,
    args: trimmed.slice(spaceIdx + 1).trim(),
  };
}

export function createDefaultRegistry(): CommandRegistry {
  const registry = new CommandRegistry();

  registry.register({
    name: "login",
    type: "local_ui",
    description: "Configure, save, and activate LLM provider",
    handler: () => "login",
  });

  registry.register({
    name: "model",
    type: "local_ui",
    description: "Switch the model of the current provider",
    handler: () => "model",
  });

  registry.register({
    name: "help",
    type: "local",
    description: "Show available commands",
    markdown: true,
    handler: (ctx) => {
      if (ctx.args) {
        const cmd = registry.find(ctx.args);
        if (!cmd) {
          return `Unknown command: ${ctx.args}`;
        }
        return `\`/${cmd.name}\` — ${cmd.description}`;
      }
      // List all commands; skills are discoverable via /skills instead.
      const cmds = registry.listCommands().filter((c) => !c.isSkill);
      const escapeCell = (value: string) => value.replace(/\|/g, "\\|");
      const rows = cmds.map(
        (c) => `| \`/${c.name}\` | ${escapeCell(c.description)} |`,
      );
      return [
        "**Available commands**",
        "",
        "| Command | Description |",
        "| --- | --- |",
        ...rows,
        "",
        "Type `/help <command>` for details.",
      ].join("\n");
    },
  });

  registry.register({
    name: "clear",
    type: "local_ui",
    description: "Clear conversation history",
    handler: () => "clear",
  });

  registry.register({
    name: "compact",
    type: "local_ui",
    description: "Force context compaction",
    handler: () => "compact",
  });

  registry.register({
    name: "status",
    type: "local",
    description: "Show current status",
    handler: (ctx) => {
      const lines: string[] = [];
      lines.push("Yukino Status");
      lines.push("──────────────");

      const mode = ctx.permissionMode ? ctx.permissionMode() : "default";
      lines.push(`  Mode:      ${mode}`);

      if (ctx.tokenCount) {
        const [input, output] = ctx.tokenCount();
        lines.push(`  Tokens:    ${String(input)} in / ${String(output)} out`);
      }

      if (ctx.toolCount) {
        lines.push(`  Tools:     ${String(ctx.toolCount())} enabled`);
      }

      if (ctx.memoryList) {
        const memories = ctx.memoryList();
        lines.push(`  Memories:  ${String(memories.length)} entries`);
      }

      if (ctx.model) {
        lines.push(`  Model:     ${ctx.model}`);
      }

      lines.push(`  Directory: ${ctx.cwd}`);

      return lines.join("\n");
    },
  });

  registry.register({
    name: "session",
    type: "local",
    description: "Show session info",
    handler: () => "Session is active. Use /resume to list past sessions.",
  });

  registry.register({
    name: "plan",
    type: "local_ui",
    description: "Enter plan mode",
    handler: () => "plan",
  });
  registry.register({
    name: "goal",
    type: "prompt",
    description:
      "Set or view a persistent goal that drives auto-continuation across turns; status, pause, resume, continue, complete, clear, replace; --budget <tokens>",
    handler: (ctx) => `/goal ${ctx.args}`.trim(),
  });

  registry.register({
    name: "resume",
    type: "local_ui",
    description: "Resume a previous session",
    handler: () => "resume",
  });

  registry.register({
    name: "quit",
    type: "local_ui",
    description: "Exit Yukino",
    handler: () => "quit",
  });

  registry.register({
    name: "memory",
    type: "local",
    description: "Show memory status",
    // Placeholder token: the TUI and remote server intercept /memory by name
    // and render the real status themselves.
    handler: () => "memory",
  });

  registry.register({
    name: "skills",
    type: "local_ui",
    description: "List available skills",
    handler: () => "skills",
  });

  registry.register({
    name: "worktree",
    type: "local_ui",
    description: "Manage git worktrees",
    handler: () => "worktree",
  });

  registry.register({
    name: "code-review",
    type: "local_ui",
    description: "Configure and run a structured AI code review",
    handler: ({ args }) => (args.trim() ? "code-review-usage" : "code-review"),
  });

  registry.register({
    name: "rewind",
    type: "local_ui",
    description: "Rewind conversation to a previous checkpoint",
    handler: () => "rewind",
  });

  registry.register({
    name: "mcp",
    type: "local",
    description:
      "Show MCP server status; /mcp reload re-reads the config and reconnects",
    // Placeholder token: the TUI and remote server intercept /mcp by name and
    // render the real status themselves.
    handler: () => "mcp",
  });

  registry.register({
    name: "sandbox",
    type: "local_ui",
    description:
      "Toggle OS sandbox mode for command execution (auto, manual, off)",
    handler: () => "sandbox",
  });

  registry.register({
    name: "thinking",
    type: "local",
    description:
      "Show or set the thinking level (off, minimal, low, medium, high, xhigh, max)",
    handler: (ctx) => {
      const arg = ctx.args.trim().toLowerCase();
      const available = ctx.availableThinkingLevels?.() ?? THINKING_LEVELS;
      if (!arg) {
        const current = ctx.thinkingLevel ? ctx.thinkingLevel() : "unknown";
        return `Thinking level: ${current}\nUsage: /thinking <${available.join(" | ")}>`;
      }
      if (!isValidThinkingLevel(arg)) {
        return `Unknown thinking level "${arg}". Available levels: ${available.join(", ")}`;
      }
      if (!available.includes(arg)) {
        return `Thinking level "${arg}" is not supported. Available levels: ${available.join(", ")}`;
      }
      if (!ctx.setThinkingLevel) {
        return "Thinking level control is not available in this context.";
      }
      let effective: ThinkingLevel;
      try {
        ctx.setThinkingLevel(arg);
        effective = ctx.thinkingLevel?.() ?? arg;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `Unable to set thinking level: ${message}. Try /thinking <${available.join(" | ")}>. Nothing was saved.`;
      }
      const adjustment = effective === arg ? "" : ` (requested ${arg})`;
      // Persist the effective level, not the request. A save failure must not
      // undo the runtime change.
      if (ctx.persistThinkingLevel) {
        try {
          ctx.persistThinkingLevel(effective);
          return `Thinking level set to ${effective}${adjustment} and saved.`;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return `Thinking level set to ${effective}${adjustment} for this session, but saving failed: ${message}`;
        }
      }
      return `Thinking level set to ${effective}${adjustment}.`;
    },
  });

  return registry;
}
