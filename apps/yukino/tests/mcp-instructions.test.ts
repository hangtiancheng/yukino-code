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

import { describe, expect, it } from "vitest";

import { ConversationManager } from "@/conversation/index.js";
import {
  MCP_INSTRUCTIONS_MARKER,
  syncMcpInstructions,
  type McpInstruction,
  type McpInstructionSource,
  type ReminderHistory,
} from "@/mcp/instructions.js";
import { contentToText } from "@/utils/index.js";

class FakeHistory implements ReminderHistory {
  reminders: string[] = [];

  hasReminderContaining(marker: string): boolean {
    return this.reminders.some((reminder) => reminder.includes(marker));
  }

  addSystemReminder(content: string): void {
    this.reminders.push(content);
  }
}

const source = (live: string[], instructions: McpInstruction[]): McpInstructionSource => ({
  connectedServers: () => live,
  connectedInstructions: () => instructions,
});

const guidance = (serverName: string): McpInstruction => ({
  serverName,
  text: `${serverName} guidance`,
});

describe("MCP instruction announcements", () => {
  it("announces connected servers once and stays quiet while they stay up", () => {
    const history = new FakeHistory();
    const announced = new Set<string>();
    const mgr = source(["a", "b"], [guidance("b"), guidance("a")]);

    expect(syncMcpInstructions(history, announced, mgr)).toBe(true);
    expect(history.reminders).toHaveLength(1);
    const reminder = history.reminders[0];
    expect(reminder).toContain(MCP_INSTRUCTIONS_MARKER);
    expect(reminder).toContain("## a\na guidance");
    expect(reminder).toContain("## b\nb guidance");
    // Sorted, so the same pool always renders the same text.
    expect(reminder.indexOf("## a")).toBeLessThan(reminder.indexOf("## b"));

    // Repeating the pass must not repeat the guidance in the context.
    expect(syncMcpInstructions(history, announced, mgr)).toBe(false);
    expect(history.reminders).toHaveLength(1);
  });

  it("sends late connections and disconnections as a single delta", () => {
    const history = new FakeHistory();
    const announced = new Set<string>();
    syncMcpInstructions(history, announced, source(["a", "b"], [guidance("a"), guidance("b")]));

    // `b` stays up, `a` is gone, `c` joined: only the change goes out.
    expect(
      syncMcpInstructions(history, announced, source(["b", "c"], [guidance("b"), guidance("c")])),
    ).toBe(true);

    const delta = history.reminders[1];
    expect(delta).toContain("## c\nc guidance");
    expect(delta).not.toContain("## b");
    expect(delta).toContain("no longer apply:\na");
    expect(announced).toEqual(new Set(["b", "c"]));
  });

  it("ignores servers that advertise no instructions", () => {
    const history = new FakeHistory();
    const announced = new Set<string>();

    expect(syncMcpInstructions(history, announced, source(["quiet"], []))).toBe(false);
    expect(history.reminders).toEqual([]);

    // Nothing was announced for it, so its departure is not news either.
    expect(syncMcpInstructions(history, announced, source([], []))).toBe(false);
    expect(history.reminders).toEqual([]);
  });

  it("re-announces everything when the announcement left the history", () => {
    const announced = new Set<string>();
    const mgr = source(["a"], [guidance("a")]);
    const before = new FakeHistory();
    syncMcpInstructions(before, announced, mgr);
    expect(announced).toEqual(new Set(["a"]));

    // Compaction collapses history into a summary, /clear and /resume rebuild it:
    // every one of them drops the reminder the announcement lived in.
    const compacted = new FakeHistory();
    expect(syncMcpInstructions(compacted, announced, mgr)).toBe(true);
    expect(compacted.reminders[0]).toContain("## a\na guidance");
    expect(compacted.reminders[0]).not.toContain("no longer apply");
    expect(compacted.reminders).toHaveLength(1);
  });

  it("announces once per conversation against the real history, and again after it is rebuilt", () => {
    // The remote handle keeps its conversation across runs and rebuilds it when a
    // session is restored, so the marker scan has to see the real reminder text.
    const conv = new ConversationManager();
    const announced = new Set<string>();
    const mgr = source(["a"], [guidance("a")]);

    conv.addUserMessage("inspect the project");
    expect(syncMcpInstructions(conv, announced, mgr)).toBe(true);
    expect(syncMcpInstructions(conv, announced, mgr)).toBe(false);
    const announcements = conv
      .getMessages()
      .filter((m) => contentToText(m.content).includes(MCP_INSTRUCTIONS_MARKER));
    expect(announcements).toHaveLength(1);

    conv.reset();
    conv.addUserMessage("inspect the project again");
    expect(syncMcpInstructions(conv, announced, mgr)).toBe(true);
  });
});
