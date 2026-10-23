import type { ConversationManager, Message } from "@yukino.js/conversation";
import type { LLMClient } from "@yukino.js/llm/client.js";
import { createChildLogger } from "@yukino.js/logger";
import { MemoryConsolidator } from "./consolidation.js";
import {
  EXTRACT_SUMMARY_WINDOW,
  MIN_EXTRACT_MESSAGES,
  MIN_SUMMARY_LINE_CHARS,
} from "./constants.js";
import { MemoryExtractor } from "./extractor.js";
import { contentToText } from "@yukino.js/utils";

const log = createChildLogger({ module: "memory" });

export class BackgroundMemoryTasks {
  private extractor: MemoryExtractor;
  private consolidator: MemoryConsolidator;
  private cursor?: Message;
  private pending: Message[] | null = null;
  private completion: Promise<void> | null = null;
  private disposed = false;

  constructor(
    client: LLMClient,
    cwd: string,
    private callbacks: {
      onSaved?: (names: string[]) => void;
      appendSystem?: (message: string) => void;
    } = {},
  ) {
    this.extractor = new MemoryExtractor(client, cwd);
    this.consolidator = new MemoryConsolidator(client, cwd, {
      appendSystem: (message) => {
        if (!this.disposed) {
          callbacks.appendSystem?.(message);
        }
      },
    });
  }

  run(conversation: ConversationManager): void {
    if (this.disposed) {
      return;
    }
    this.pending = [...conversation.getMessages()];
    if (!this.completion) {
      this.startDrain();
    }
    void this.consolidator.maybeRun();
  }

  private startDrain(): void {
    this.completion = this.drain().finally(() => {
      this.completion = null;
      if (this.pending && !this.disposed) {
        this.startDrain();
      }
    });
  }

  private async drain(): Promise<void> {
    while (this.pending && !this.disposed) {
      const messages = this.pending;
      this.pending = null;
      const start = this.cursor ? messages.indexOf(this.cursor) + 1 : 0;
      if (messages.length - start < MIN_EXTRACT_MESSAGES) {
        continue;
      }
      const summary = messages
        .slice(Math.max(start, messages.length - EXTRACT_SUMMARY_WINDOW))
        .map(
          (message) => `[${message.role}]: ${contentToText(message.content)}`,
        )
        .filter((text) => text.length > MIN_SUMMARY_LINE_CHARS)
        .join("\n");
      try {
        const saved = await this.extractor.extract(summary);
        if (this.disposed) {
          return;
        }
        this.cursor = messages.at(-1);
        if (saved.length > 0) {
          this.callbacks.onSaved?.(saved);
        }
      } catch (err) {
        if (!this.disposed) {
          log.error({ err }, "memory extractor failed");
        }
      }
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.pending = null;
    await Promise.all([
      this.extractor.dispose(),
      this.consolidator.dispose(),
      this.completion,
    ]);
  }
}
