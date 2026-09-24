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

import { describe, expect, it, vi } from "vitest";

import { RecoveryState } from "@/compact/recovery.js";
import { ConversationManager } from "@/conversation/index.js";
import { FileHistory } from "@/file-history/index.js";
import { parseRemoteAddress } from "@/remote/address.js";
import { RemoteServer } from "@/remote/server.js";
import { restoreRemoteSession } from "@/remote/session-state.js";
import type { SessionMessage } from "@/session/index.js";
import { FileStateCache } from "@/tools/file-state-cache.js";

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    /** noop */
  };
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("remote execution boundaries", () => {
  it("defaults to loopback and preserves explicit network and IPv6 binding", () => {
    expect(parseRemoteAddress(":18888")).toEqual({
      host: "127.0.0.1",
      port: 18888,
    });
    expect(parseRemoteAddress(":9000")).toEqual({
      host: "127.0.0.1",
      port: 9000,
    });
    expect(parseRemoteAddress("0.0.0.0:9000")).toEqual({
      host: "0.0.0.0",
      port: 9000,
    });
    expect(parseRemoteAddress("[::1]:9000")).toEqual({
      host: "::1",
      port: 9000,
    });
  });

  it.each(["localhost:9000oops", ":65536", ":-1", ":0", "::1:9000"])(
    "rejects invalid address %s before starting an agent",
    (address) => {
      expect(() => parseRemoteAddress(address)).toThrow();
    },
  );

  it("restores tool results and image attachments without replacing the fork's conversation", () => {
    const workDir = mkdtempSync(join(tmpdir(), "yukino-remote-"));
    try {
      const conv = new ConversationManager();
      conv.addUserMessage("old session");
      const state: Parameters<typeof restoreRemoteSession>[0] = {
        workDir,
        conv,
        sessionId: "old",
        fileHistory: new FileHistory(workDir, "old"),
        fileStateCache: new FileStateCache(),
        recoveryState: new RecoveryState(),
        activeSkills: new Map([["old", "old instructions"]]),
        toolFilter: () => false,
      };
      const forkSnapshot = () => conv.fork();
      state.fileStateCache.record("old-file", 1);
      state.recoveryState.recordFileRead("old-file", "old content");
      const saved: SessionMessage[] = [
        {
          role: "assistant",
          content: "read",
          timestamp: 1,
          tool_uses: [
            {
              tool_use_id: "read",
              tool_name: "ReadFile",
              arguments: { file_path: "image.png" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "aGVsbG8=",
              },
            },
            { type: "text", text: "attachment note" },
          ],
          timestamp: 2,
          tool_results: [
            { tool_use_id: "read", content: "image read", is_error: false },
          ],
        },
      ];
      const snapshot = JSON.stringify(saved);
      restoreRemoteSession(state, "new", saved);
      expect(state.conv).toBe(conv);
      expect(forkSnapshot().getMessages().at(-1)?.content).toEqual(
        saved[1]?.content,
      );
      expect(
        forkSnapshot().getMessages().at(-1)?.toolResults?.[0]?.content,
      ).toBe("image read");
      expect(JSON.stringify(saved)).toBe(snapshot);
      expect(state.sessionId).toBe("new");
      expect(state.activeSkills.size).toBe(0);
      expect(state.toolFilter).toBeNull();
      expect(state.fileStateCache.has("old-file")).toBe(false);
      expect(state.recoveryState.snapshotFiles()).toEqual([]);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("settles pending permission and question waits when stopping the server", async () => {
    const server = new RemoteServer({
      providers: [],
      addr: ":18888",
      enableCoordinatorMode: false,
      forkDisabled: true,
    });
    const permission = deferred<"allow" | "deny" | "allowAlways">();
    const question = deferred<Record<string, string>>();
    const abort = vi.fn();
    Reflect.set(server, "agentHandle", { abort });
    Reflect.set(
      server,
      "pendingPermissions",
      new Map([["permission", permission.resolve]]),
    );
    Reflect.set(
      server,
      "pendingAsks",
      new Map([["question", question.resolve]]),
    );
    server.stop();
    expect(abort).toHaveBeenCalledOnce();
    await expect(permission.promise).resolves.toBe("deny");
    await expect(question.promise).resolves.toEqual({});
  });
});
