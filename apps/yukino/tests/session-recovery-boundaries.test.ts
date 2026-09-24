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

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadSession,
  rebuildFromSession,
  saveCompactBoundary,
  saveMessage,
  type SessionMessage,
} from "@/session/index.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("empty session content arrays", () => {
  it("skips empty arrays on load and replay but keeps tool-only messages", () => {
    const directory = mkdtempSync(join(tmpdir(), "yukino-session-boundary-"));
    directories.push(directory);
    const records: SessionMessage[] = [
      { role: "user", content: "task", timestamp: 1 },
      { role: "assistant", content: [], timestamp: 2 },
      { role: "user", content: [], timestamp: 3 },
      {
        role: "assistant",
        content: [],
        timestamp: 4,
        tool_uses: [{ tool_use_id: "a", tool_name: "ReadFile", arguments: {} }],
      },
      {
        role: "user",
        content: [],
        timestamp: 5,
        tool_results: [{ tool_use_id: "a", content: "ok" }],
      },
    ];
    for (const record of records) {
      saveMessage(directory, "session", record);
    }
    expect(loadSession(directory, "session")).toHaveLength(3);
    expect(rebuildFromSession(records)).toHaveLength(3);

    saveCompactBoundary(directory, "session", {
      summary: "summary",
      keep: records,
    });
    const restored = rebuildFromSession(loadSession(directory, "session"));
    expect(restored).toHaveLength(4);
    expect(restored[2].toolUses?.[0].toolUseId).toBe("a");
    expect(restored[3].toolResults?.[0].content).toBe("ok");
  });
});
