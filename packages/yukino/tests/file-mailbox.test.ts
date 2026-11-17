import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { describe, it, expect } from "vitest";

import { tryAcquireFileSyncLock, withFileSyncLock } from "@/teams/file-lock.js";
import { FileMailbox } from "@/teams/file-mailbox.js";

describe("FileMailbox", () => {
  it("delivers only unread messages and advances the cursor", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yukino-mbox-"));
    const mbox = new FileMailbox(dir, "alice");

    await mbox.send("leader", "first");
    expect((await mbox.receive()).map((m) => m.text)).toEqual(["first"]);
    expect(await mbox.receive()).toEqual([]);

    await mbox.send("leader", "second");
    expect((await mbox.receive()).map((m) => m.text)).toEqual(["second"]);
  });

  it("persists the read cursor across instances (process restart)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yukino-mbox-"));
    const writer = new FileMailbox(dir, "bob");
    await writer.send("leader", "a");
    await writer.send("leader", "b");

    const reader1 = new FileMailbox(dir, "bob");
    expect((await reader1.receive()).map((m) => m.text)).toEqual(["a", "b"]);

    await writer.send("leader", "c");

    // A brand-new instance (simulating a restarted process) must resume after
    // "b", not re-read from the beginning.
    const reader2 = new FileMailbox(dir, "bob");
    expect(reader2.unreadCount()).toBe(1);
    expect((await reader2.receive()).map((m) => m.text)).toEqual(["c"]);
  });
});

describe("FileMailbox lock ownership", () => {
  it("fails fast on recursive acquisition in the same process", () => {
    const dir = mkdtempSync(join(tmpdir(), "yukino-mbox-"));
    const path = join(dir, "nested.json");

    expect(() => {
      withFileSyncLock(path, () => {
        withFileSyncLock(path, () => 1);
      });
    }).toThrow("recursive acquisition");
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it("does not acquire while another process is choosing a ticket", () => {
    const dir = mkdtempSync(join(tmpdir(), "yukino-mbox-"));
    const path = join(dir, "choosing.json");
    const lockDir = `${path}.lock`;
    mkdirSync(lockDir);
    const choosing = join(lockDir, `choosing-${String(process.pid)}-other`);
    writeFileSync(choosing, String(process.pid));

    expect(tryAcquireFileSyncLock(path)).toBeNull();
    expect(readdirSync(lockDir)).toEqual([basename(choosing)]);
  });

  it("does not preempt a stale ticket held by a live process", () => {
    const dir = mkdtempSync(join(tmpdir(), "yukino-mbox-"));
    const path = join(dir, "live-holder.json");
    const lockDir = `${path}.lock`;
    mkdirSync(lockDir);
    const liveTicket = join(
      lockDir,
      `ticket-0000000000000001-${String(process.pid)}-live`,
    );
    writeFileSync(liveTicket, String(process.pid));
    const stale = new Date(Date.now() - 60_000);
    utimesSync(liveTicket, stale, stale);

    expect(tryAcquireFileSyncLock(path)).toBeNull();
    expect(existsSync(liveTicket)).toBe(true);
    expect(readdirSync(lockDir)).toEqual([basename(liveTicket)]);
  });

  it("removes only the uniquely named stale ticket before acquiring", () => {
    const dir = mkdtempSync(join(tmpdir(), "yukino-mbox-"));
    const path = join(dir, "dead-holder.json");
    const lockDir = `${path}.lock`;
    mkdirSync(lockDir);
    const deadTicket = join(lockDir, "ticket-0000000000000001-999999999-dead");
    writeFileSync(deadTicket, "999999999");
    const stale = new Date(Date.now() - 60_000);
    utimesSync(deadTicket, stale, stale);

    const release = tryAcquireFileSyncLock(path);
    expect(release).toBeTypeOf("function");
    expect(existsSync(deadTicket)).toBe(false);
    expect(readdirSync(lockDir)).toHaveLength(1);
    release?.();
    expect(existsSync(lockDir)).toBe(false);
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
