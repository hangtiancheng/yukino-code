import { SYSTEM_REMINDER_OPEN } from "./constants.js";
import { buildLongTermMemoryReminder, wrapSystemReminder } from "./prompts.js";
import type { UserInput } from "@yukino.js/history";
import type { ToolResultContentBlock } from "@yukino.js/tools/types.js";
import { contentToText } from "@yukino.js/utils";

// Submodule namespaces for library consumers (Conversation.<Sub>.*).
export * from "./at-expand.js";
export * from "./constants.js";
export * from "./pairing.js";
export * from "./prompts.js";
export * from "./user-bash.js";

export interface ToolUseBlock {
  toolUseId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  parseError?: string;
  providerItemId?: string;
}

export interface ToolResultBlock {
  toolUseId: string;
  content: string;
  contentBlocks?: ToolResultContentBlock[];
  isError: boolean;
}

/**
 * An assistant reasoning block. "thinking" carries the visible summary plus its
 * cryptographic signature; "redacted_thinking" carries opaque encrypted data
 * that must be replayed verbatim and never decoded, logged, or displayed.
 */
export type ThinkingBlock =
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string };

export interface Message {
  role: "user" | "assistant" | "system";
  /** Plain text, or content blocks (text/image) for user messages carrying
   * attachments. Assistant/system content is always plain text in practice. */
  content: string | Record<string, unknown>[];
  thinkingBlocks?: ThinkingBlock[] | undefined;
  toolUses?: ToolUseBlock[] | undefined;
  toolResults?: ToolResultBlock[] | undefined;
  userBash?: UserBashResult;
  userInput?: UserInput;
}

export interface UserBashResult {
  command: string;
  output: string;
  isError: boolean;
  elapsed: number;
  status: "completed" | "failed" | "stopped";
  excludeFromContext: boolean;
}

export class ConversationManager {
  private history: Message[] = [];
  private longTermMemoryInjected = false;
  private baselineTokens = 0;
  private _anchorCount = 0;

  addUserMessage(
    content: string | Record<string, unknown>[],
    userInput?: UserInput,
  ): void {
    this.history.push({
      role: "user",
      content,
      ...(userInput
        ? { userInput: { id: userInput.id, timestamp: userInput.timestamp } }
        : {}),
    });
  }

  addAssistantFull(
    text: string,
    thinking: ThinkingBlock[],
    toolUses: ToolUseBlock[],
  ): void {
    this.history.push({
      role: "assistant",
      content: text,
      thinkingBlocks: thinking.length > 0 ? thinking : undefined,
      toolUses: toolUses.length > 0 ? toolUses : undefined,
    });
  }

  addToolResultsMessage(results: ToolResultBlock[]): void {
    this.history.push({
      role: "user",
      content: "",
      toolResults: results,
    });
  }

  addSystemReminder(content: string): void {
    this.history.push({
      role: "user",
      content: wrapSystemReminder(content),
    });
  }

  addSystemReminderIfChanged(marker: string, content: string): void {
    const prefix = `${SYSTEM_REMINDER_OPEN}\n${marker}`;
    const latest = this.history.findLast(
      (message) =>
        message.role === "user" &&
        typeof message.content === "string" &&
        message.content.startsWith(prefix),
    );
    if (latest?.content !== wrapSystemReminder(content)) {
      this.addSystemReminder(content);
    }
  }

  /**
   * Check whether a reminder containing `marker` still exists in history.
   *
   * Used to decide whether a "say-once" reminder needs re-injection. Compaction
   * collapses history into a summary, which removes the original reminder; the
   * caller uses this result to re-inject without hooking into the compaction path.
   */
  hasReminderContaining(marker: string): boolean {
    return this.history.some(
      (m) => m.role === "user" && contentToText(m.content).includes(marker),
    );
  }

  injectLongTermMemory(
    instructions: string,
    memories: string,
    skills = "",
  ): void {
    if (this.longTermMemoryInjected) {
      return;
    }
    const today = new Date().toISOString().split("T")[0];
    const wrapped = buildLongTermMemoryReminder(
      instructions,
      memories,
      skills,
      today,
    );
    if (wrapped === null) {
      return;
    }
    this.history.unshift({ role: "user", content: wrapped });
    this.longTermMemoryInjected = true;
  }

  appendMessages(msgs: Message[]): void {
    this.history.push(...msgs);
  }

  fork(): ConversationManager {
    const fork = new ConversationManager();
    fork.history = structuredClone(this.history);
    fork.longTermMemoryInjected = this.longTermMemoryInjected;
    fork.baselineTokens = this.baselineTokens;
    fork._anchorCount = this._anchorCount;
    return fork;
  }

  len(): number {
    return this.history.length;
  }

  truncateTo(index: number): void {
    if (index < 0) {
      index = 0;
    }

    if (index > this.history.length) {
      return;
    }

    this.history = this.history.slice(0, index);
    this.clearUsageAnchor();
    if (index === 0) {
      this.longTermMemoryInjected = false;
    }
  }

  // Empties the conversation in place. Replacing the manager would strand every
  // component that captured the old instance — AgentTool holds one for its fork
  // path — so a reset has to happen behind the same object. Clearing
  // longTermMemoryInjected lets instructions, memories and skills be re-injected,
  // exactly as they are for a brand-new conversation.
  reset(): void {
    this.history = [];
    this.longTermMemoryInjected = false;
    this.clearUsageAnchor();
  }

  getMessages(): Message[] {
    return [...this.history];
  }

  // Rebuild the history after a compaction: a summary user message followed by
  // the verbatim recent tail (kept messages, structure preserved —
  // tool_use/tool_result blocks intact). Used by doCompact so recent original
  // messages survive instead of being collapsed into the summary. Ordering:
  // summary first, then kept messages. No assistant ack — the kept tail already starts with an
  // assistant message in most cases, and injecting an artificial ack wastes
  // tokens and confuses the model's sense of conversation flow.
  replaceWithCompacted(
    summaryContent: string,
    messagesToKeep: Message[],
  ): void {
    this.history = [
      { role: "user", content: summaryContent },
      ...messagesToKeep,
    ];
    this.longTermMemoryInjected = false;
    this.clearUsageAnchor();
  }

  recordUsageAnchor(
    input: number,
    output: number,
    cacheRead: number,
    cacheCreation: number,
  ): void {
    const baseline = input + cacheRead + cacheCreation + output;
    if (baseline <= 0) {
      return;
    }
    this.baselineTokens = baseline;
    this._anchorCount = this.history.length;
  }

  clearUsageAnchor(): void {
    this.baselineTokens = 0;
    this._anchorCount = 0;
  }

  usageAnchorState(): { baselineTokens: number; anchorCount: number } | null {
    if (this.baselineTokens <= 0) {
      return null;
    }
    return {
      baselineTokens: this.baselineTokens,
      anchorCount: this._anchorCount,
    };
  }
}
