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

import {
  isValidThinkingLevel,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "@/config/index.js";

export type CommandType = "local" | "local_ui" | "prompt" | "skill_fork";

export interface CommandContext {
  workDir: string;
  args: string;
  conversation?: unknown;
  registry?: unknown;
  /** Returns the current permission mode */
  permissionMode?: () => string;
  /** Returns token usage [input, output] */
  tokenCount?: () => [number, number];
  /** Returns the number of currently enabled tools */
  toolCount?: () => number;
  /** Returns the list of memories */
  memoryList?: () => string[];
  /** Clears all memories */
  memoryClear?: () => void;
  /** Returns the current model name */
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
}

export class CommandRegistry {
  private commands = new Map<string, Command>();
  /**
   * Registers a command, checking for name and alias conflicts.
   * The name must not conflict with existing command names or aliases;
   * aliases must not conflict with existing command names or other aliases.
   */
  register(cmd: Command): void {
    // Check if the command name conflicts with an existing command name
    if (this.commands.has(cmd.name)) {
      throw new Error(`Command '${cmd.name}' already registered`);
    }
    this.commands.set(cmd.name, cmd);
  }

  /**
   * Checks if a command would conflict with already registered commands.
   * Dynamic loaders (e.g., for user-defined commands) should call this method
   * before `register` to filter out conflicting entries, as `register` throws
   * an exception on conflict.
   */
  hasConflict(cmd: Command): boolean {
    if (this.find(cmd.name)) {
      return true;
    }
    return false;
  }

  find(name: string): Command | undefined {
    return this.commands.get(name);
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
    description: "Configure, save, and activate an LLM provider",
    handler: () => "login",
  });

  registry.register({
    name: "help",
    type: "local",
    description: "Show available commands",
    handler: (ctx) => {
      // Support /help <cmd> to view details of a single command
      if (ctx.args) {
        const cmd = registry.find(ctx.args);
        if (!cmd) {
          return `Unknown command: ${ctx.args}`;
        }
        return `/${cmd.name} — ${cmd.description}\n`;
      }
      // List all commands; skills are discoverable via /skills instead.
      const cmds = registry.listCommands().filter((c) => !c.isSkill);
      let output = "Available commands:\n\n";
      output += cmds
        .map((c) => {
          return `  /${c.name}\n    ${c.description}`;
        })
        .join("\n");
      output += "\n\nType /help <command> for details.";
      return output;
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
      // Display actual runtime status instead of placeholder text
      const lines: string[] = [];
      lines.push("Yukino Status");
      lines.push("──────────────");

      // Permission mode
      const mode = ctx.permissionMode ? ctx.permissionMode() : "default";
      lines.push(`  Mode:      ${mode}`);

      // Token usage
      if (ctx.tokenCount) {
        const [input, output] = ctx.tokenCount();
        lines.push(`  Tokens:    ${String(input)} in / ${String(output)} out`);
      }

      // Number of tools
      if (ctx.toolCount) {
        lines.push(`  Tools:     ${String(ctx.toolCount())} enabled`);
      }

      // Number of memories
      if (ctx.memoryList) {
        const memories = ctx.memoryList();
        lines.push(`  Memories:  ${String(memories.length)} entries`);
      }

      // Model
      if (ctx.model) {
        lines.push(`  Model:     ${ctx.model}`);
      }

      // Working directory
      lines.push(`  Directory: ${ctx.workDir}`);

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
    type: "local",
    description: "Manage code review team (create, add, remove, list)",
    handler: (ctx) => {
      const args = ctx.args.trim();
      if (!args) {
        return "Usage: /code-review <command> [args]\nCommands: create, add <name>, remove <name>, list, status";
      }
      return `code-review:${args}`;
    },
  });

  registry.register({
    name: "review",
    type: "prompt",
    description:
      "Review the uncommitted code changes for bugs and improvements",
    handler: (ctx) =>
      "Review the current uncommitted changes. Run `git status` and `git diff` to see them, " +
      "then report concrete findings (file:line) for correctness bugs, security issues, and obvious " +
      "simplifications. Be specific and concise." +
      (ctx.args ? `\n\nFocus on: ${ctx.args}` : ""),
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
    handler: () => "mcp",
  });

  registry.register({
    name: "sandbox",
    type: "local_ui",
    description: "Toggle OS sandbox mode for command execution",
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
