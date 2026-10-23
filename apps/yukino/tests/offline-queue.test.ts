import { OfflineMessageQueue } from "@yukino.js/remote-browser/hooks/offline-queue.js";
import { describe, expect, it } from "vitest";

describe("offline chat queue", () => {
  it("rejects overflow while retaining every accepted message in FIFO order", () => {
    const queue = new OfflineMessageQueue();
    const messages = Array.from(
      { length: 100 },
      (_, index) => `message ${String(index)}`,
    );
    for (const message of messages) {
      expect(queue.enqueue(message)).toBe(true);
    }
    expect(queue.enqueue("must stay in the composer")).toBe(false);
    expect(queue.drain()).toEqual(messages);
    expect(queue.enqueue("after reconnect")).toBe(true);
    expect(queue.drain()).toEqual(["after reconnect"]);
  });

  it("measures UTF-8 bytes and rejects an oversized first message", () => {
    const queue = new OfflineMessageQueue();
    expect(queue.enqueue("界".repeat(333_334))).toBe(false);
    expect(queue.drain()).toEqual([]);
    expect(queue.enqueue("界".repeat(300_000))).toBe(true);
    expect(queue.enqueue("a".repeat(100_001))).toBe(false);
    expect(queue.drain()).toEqual(["界".repeat(300_000)]);
  });
});
