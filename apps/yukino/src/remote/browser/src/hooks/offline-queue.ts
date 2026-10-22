import { MAX_PENDING_BYTES, MAX_PENDING_MESSAGES } from "#/constants.js";

export class OfflineMessageQueue {
  private entries: string[] = [];
  private bytes = 0;

  enqueue(json: string): boolean {
    const bytes = new TextEncoder().encode(json).length;
    if (
      this.entries.length >= MAX_PENDING_MESSAGES ||
      this.bytes + bytes > MAX_PENDING_BYTES
    ) {
      return false;
    }
    this.entries.push(json);
    this.bytes += bytes;
    return true;
  }

  drain(): string[] {
    this.bytes = 0;
    return this.entries.splice(0);
  }
}
