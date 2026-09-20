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

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { FileMailbox } from "@/teams/file-mailbox.js";

describe("FileMailbox", () => {
  it("delivers only unread messages and advances the cursor", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yukino-mbox-"));
    const mbox = new FileMailbox(dir, "alice");

    await mbox.send("lead", "first");
    expect((await mbox.receive()).map((m) => m.text)).toEqual(["first"]);
    // Nothing new yet.
    expect(await mbox.receive()).toEqual([]);

    await mbox.send("lead", "second");
    expect((await mbox.receive()).map((m) => m.text)).toEqual(["second"]);
  });

  it("persists the read cursor across instances (process restart)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yukino-mbox-"));
    const writer = new FileMailbox(dir, "bob");
    await writer.send("lead", "a");
    await writer.send("lead", "b");

    const reader1 = new FileMailbox(dir, "bob");
    expect((await reader1.receive()).map((m) => m.text)).toEqual(["a", "b"]);

    await writer.send("lead", "c");

    // A brand-new instance (simulating a restarted process) must resume after
    // "b", not re-read from the beginning.
    const reader2 = new FileMailbox(dir, "bob");
    expect(reader2.unreadCount()).toBe(1);
    expect((await reader2.receive()).map((m) => m.text)).toEqual(["c"]);
  });

  it("markAllRead consumes without returning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yukino-mbox-"));
    const mbox = new FileMailbox(dir, "carol");
    await mbox.send("lead", "x");
    await mbox.send("lead", "y");
    mbox.markAllRead();
    expect(mbox.unreadCount()).toBe(0);
    expect(await mbox.receive()).toEqual([]);
  });
});

describe("FileMailbox concurrent writes", () => {
  it("keeps every message when many writes race for the same inbox", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yukino-mbox-"));
    // 20 writers each hold a handle to the same inbox; failing to acquire the lock throws rather than silently dropping messages
    const writers = Array.from(
      { length: 20 },
      () => new FileMailbox(dir, "dest"),
    );

    await Promise.all(
      writers.map((mbox, i) =>
        mbox.send(`sender-${String(i)}`, `msg-${String(i)}`),
      ),
    );

    const received = await new FileMailbox(dir, "dest").receive();
    expect(received).toHaveLength(20);
    expect(new Set(received.map((m) => m.text)).size).toBe(20);
  });
});
