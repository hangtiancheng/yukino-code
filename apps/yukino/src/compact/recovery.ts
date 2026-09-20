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

// Recovery budgets for the attachment block appended to the summary
// message. Compact wipes the working conversation; without these
// snapshots the model would forget which files it just read and which
// skill SOPs it was operating under.
const RECOVERY_FILE_LIMIT = 5;
const RECOVERY_TOKENS_PER_FILE = 5_000;
const RECOVERY_SKILLS_BUDGET = 25_000;
const RECOVERY_TOKENS_PER_SKILL = 5_000;
const RECOVERY_CHARS_PER_TOKEN = 3.5;

function approxTokens(s: string): number {
  if (!s) {
    return 0;
  }
  return Math.floor(s.length / RECOVERY_CHARS_PER_TOKEN);
}

function truncateByTokens(s: string, tokenBudget: number): string {
  if (tokenBudget <= 0 || !s) {
    return s;
  }
  if (approxTokens(s) <= tokenBudget) {
    return s;
  }
  const maxChars = Math.floor(tokenBudget * RECOVERY_CHARS_PER_TOKEN);
  if (maxChars <= 0 || maxChars >= s.length) {
    return s;
  }
  const suffix = "\n… (content truncated)";
  if (maxChars <= suffix.length) {
    return suffix.slice(0, maxChars);
  }
  return s.slice(0, maxChars - suffix.length) + suffix;
}

// function firstLine(s: string): string {
//   for (const line of s.split("\n")) {
//     const trimmed = line.trim();
//     if (trimmed) return trimmed;
//   }
//   return "";
// }

interface FileReadRecord {
  path: string;
  content: string;
  timestamp: number;
}

interface SkillInvocationRecord {
  name: string;
  body: string;
  timestamp: number;
}

export class RecoveryState {
  private files = new Map<string, FileReadRecord>();
  private skills = new Map<string, SkillInvocationRecord>();

  recordFileRead(path: string, content: string): void {
    this.files.delete(path);
    this.files.set(path, {
      path,
      content: truncateByTokens(content, RECOVERY_TOKENS_PER_FILE),
      timestamp: Date.now(),
    });
    while (this.files.size > RECOVERY_FILE_LIMIT) {
      const oldestPath = this.files.keys().next().value;
      if (typeof oldestPath !== "string") {
        break;
      }
      this.files.delete(oldestPath);
    }
  }

  recordSkillInvocation(name: string, body: string): void {
    this.skills.set(name, { name, body, timestamp: Date.now() });
  }

  snapshotFiles(limit = RECOVERY_FILE_LIMIT): FileReadRecord[] {
    const sorted = [...this.files.values()].sort((a, b) => b.timestamp - a.timestamp);
    return sorted.slice(0, limit);
  }

  snapshotSkills(): SkillInvocationRecord[] {
    return [...this.skills.values()].sort((a, b) => b.timestamp - a.timestamp);
  }

  buildRecoveryAttachment(toolSchemaNames: string[]): string {
    const sections: string[] = [];

    const recentFiles = this.snapshotFiles();
    if (recentFiles.length > 0) {
      sections.push("## Recently read files\n");
      sections.push(
        "These snapshots are what the file-reading tool last returned. Re-open with the tool if you need the current bytes.\n",
      );
      for (const f of recentFiles) {
        const content = truncateByTokens(f.content, RECOVERY_TOKENS_PER_FILE);
        const ts = new Date(f.timestamp).toISOString().replace(/\.\d{3}Z$/, "Z");
        sections.push(
          `### ${f.path}  (read ${ts})\n\n\`\`\`\n${content}${content.endsWith("\n") ? "" : "\n"}\`\`\``,
        );
      }
    }

    const skills = this.snapshotSkills();
    if (skills.length > 0) {
      let used = 0;
      const skillParts: string[] = [];
      skillParts.push("## Active skills\n");
      skillParts.push(
        "These skills were invoked earlier in the session. Continue to follow each SOP when its triggering condition applies.\n",
      );
      let emitted = false;
      for (const sk of skills) {
        const body = truncateByTokens(sk.body, RECOVERY_TOKENS_PER_SKILL);
        const tokens = approxTokens(body) + approxTokens(sk.name) + 8;
        if (used + tokens > RECOVERY_SKILLS_BUDGET) {
          break;
        }
        used += tokens;
        skillParts.push(`### ${sk.name}\n\n${body}`);
        emitted = true;
      }
      if (emitted) {
        sections.push(skillParts.join("\n\n"));
      }
    }

    if (toolSchemaNames.length > 0) {
      sections.push(
        "## Available tools\n\nYou still have access to the following tools — call them directly when the task needs one:\n\n" +
          toolSchemaNames.map((n) => `- ${n}`).join("\n"),
      );
    }

    if (sections.length === 0) {
      return "";
    }

    sections.push(
      "## Note\n\nEverything above the divider is reconstructed context. For exact code, error strings, or user-typed text, re-read the source rather than guess from the summary.",
    );

    return sections.join("\n\n");
  }
}
