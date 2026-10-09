// Recovery budgets for the attachment block appended to the summary
// message. Compaction collapses the working conversation into a summary;
// without these snapshots the model would forget which files it just read.
// Active skill SOPs are re-injected after compaction by Agent.restoreContext →
// ConversationManager.injectLongTermMemory (agent/index.ts), not through
// this attachment.
const RECOVERY_FILE_LIMIT = 5;
const RECOVERY_TOKENS_PER_FILE = 5_000;
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

interface FileReadRecord {
  path: string;
  content: string;
  timestamp: number;
}

export class RecoveryState {
  private files = new Map<string, FileReadRecord>();

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

  snapshotFiles(limit = RECOVERY_FILE_LIMIT): FileReadRecord[] {
    const sorted = [...this.files.values()].sort(
      (a, b) => b.timestamp - a.timestamp,
    );
    return sorted.slice(0, limit);
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
        const ts = new Date(f.timestamp)
          .toISOString()
          .replace(/\.\d{3}Z$/, "Z");
        sections.push(
          `### ${f.path}  (read ${ts})\n\n\`\`\`\n${content}${content.endsWith("\n") ? "" : "\n"}\`\`\``,
        );
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
