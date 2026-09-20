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

import * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";

import {
  createYukinoAcpApp,
  type AcpRuntime,
  type AcpRuntimeFactory,
} from "@/acp/agent.js";
import type { AgentEvent } from "@/agent/events.js";
import { ConversationManager } from "@/conversation/index.js";
import { saveMessage } from "@/session/index.js";

function fakeRuntime(
  sessionId: string,
  workDir: string,
  events: AgentEvent[] = [],
  onRun?: (callbacks: Parameters<AcpRuntime["run"]>[1]) => Promise<void>,
): AcpRuntime {
  return {
    sessionId,
    workDir,
    contextWindow: 200_000,
    conv: new ConversationManager(),
    async *run(text, callbacks) {
      this.conv.addUserMessage(text);
      if (onRun) {
        await onRun(callbacks);
      }
      for (const event of events) {
        yield event;
      }
    },
    abort: vi.fn(),
    dispose: vi.fn(() => Promise.resolve()),
  };
}

function initialize(
  context: acp.ClientContext,
): Promise<acp.InitializeResponse> {
  return context.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {},
  });
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("Yukino ACP agent", () => {
  it("runs prompts, streams events and bridges permissions", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "yukino-acp-"));
    const permissionResults: string[] = [];
    const runtime = fakeRuntime(
      "session-12345678",
      workDir,
      [
        { type: "stream_text", text: "done" },
        {
          type: "tool_result",
          toolName: "WriteFile",
          toolId: "tool-1",
          output: "written",
          isError: false,
          elapsed: 0.1,
        },
        {
          type: "usage",
          usage: {
            inputTokens: 10,
            outputTokens: 2,
            cacheReadInputTokens: 3,
            cacheCreationInputTokens: 4,
          },
        },
        { type: "loop_complete", stopReason: "end_turn" },
      ],
      async (callbacks) => {
        const result = await callbacks.onPermissionRequest(
          "WriteFile",
          { file_path: "result.txt" },
          { effect: "ask", reason: "Mode: default" },
          "tool-1",
        );
        permissionResults.push(result);
      },
    );
    const dispose = vi.spyOn(runtime, "dispose");
    const factory: AcpRuntimeFactory = () => Promise.resolve(runtime);
    const implementation = createYukinoAcpApp(factory);
    const updates: acp.SessionNotification[] = [];
    const permissionIds: string[] = [];
    const client = acp
      .client({ name: "test-client" })
      .onNotification(acp.methods.client.session.update, (context) => {
        updates.push(context.params);
      })
      .onRequest(acp.methods.client.session.requestPermission, (context) => {
        permissionIds.push(context.params.toolCall.toolCallId);
        return { outcome: { outcome: "selected", optionId: "allowAlways" } };
      });

    try {
      await client.connectWith(implementation.app, async (context) => {
        await initialize(context);
        const created = await context.request(acp.methods.agent.session.new, {
          cwd: workDir,
          mcpServers: [],
        });
        const response = await context.request(
          acp.methods.agent.session.prompt,
          {
            sessionId: created.sessionId,
            prompt: [{ type: "text", text: "write it" }],
          },
        );
        expect(response.stopReason).toBe("end_turn");
        expect(response.usage?.totalTokens).toBe(19);
        await context.request(acp.methods.agent.session.close, {
          sessionId: created.sessionId,
        });
      });

      expect(permissionIds).toEqual(["tool-1"]);
      expect(permissionResults).toEqual(["allowAlways"]);
      expect(
        updates.map((notification) => notification.update.sessionUpdate),
      ).toEqual(["agent_message_chunk", "tool_call_update", "usage_update"]);
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("cancels a turn waiting for a permission response", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "yukino-acp-"));
    const permissionStarted = deferred();
    const permissionResults: string[] = [];
    const runtime = fakeRuntime(
      "session-abcdef12",
      workDir,
      [{ type: "loop_complete", stopReason: "interrupted" }],
      async (callbacks) => {
        permissionStarted.resolve();
        permissionResults.push(
          await callbacks.onPermissionRequest(
            "WriteFile",
            { file_path: "result.txt" },
            { effect: "ask", reason: "Mode: default" },
            "tool-2",
          ),
        );
      },
    );
    const abort = vi.spyOn(runtime, "abort");
    const implementation = createYukinoAcpApp(() => Promise.resolve(runtime));
    const client = acp
      .client({ name: "test-client" })
      .onRequest(
        acp.methods.client.session.requestPermission,
        () => new Promise<acp.RequestPermissionResponse>(() => undefined),
      );

    try {
      await client.connectWith(implementation.app, async (context) => {
        await initialize(context);
        const created = await context.request(acp.methods.agent.session.new, {
          cwd: workDir,
          mcpServers: [],
        });
        const prompt = context.request(acp.methods.agent.session.prompt, {
          sessionId: created.sessionId,
          prompt: [{ type: "text", text: "write it" }],
        });
        await permissionStarted.promise;
        await context.notify(acp.methods.agent.session.cancel, {
          sessionId: created.sessionId,
        });
        await expect(prompt).resolves.toMatchObject({
          stopReason: "cancelled",
        });
      });
      expect(permissionResults).toEqual(["deny"]);
      expect(abort).toHaveBeenCalled();
    } finally {
      await implementation.dispose();
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("lists, loads and replays persisted sessions", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "yukino-acp-"));
    const sessionId = "saved-12345678";
    saveMessage(workDir, sessionId, {
      role: "user",
      content: "hello",
      timestamp: 1,
    });
    saveMessage(workDir, sessionId, {
      role: "assistant",
      content: "world",
      timestamp: 2,
    });
    const runtimes: AcpRuntime[] = [];
    const factory: AcpRuntimeFactory = (cwd, requestedId) => {
      const runtime = fakeRuntime(requestedId ?? "new-12345678", cwd);
      runtimes.push(runtime);
      return Promise.resolve(runtime);
    };
    const implementation = createYukinoAcpApp(factory);
    const updates: acp.SessionNotification[] = [];
    const client = acp
      .client({ name: "test-client" })
      .onNotification(acp.methods.client.session.update, (context) => {
        updates.push(context.params);
      });

    try {
      await client.connectWith(implementation.app, async (context) => {
        await initialize(context);
        const listed = await context.request(acp.methods.agent.session.list, {
          cwd: workDir,
        });
        expect(listed.sessions).toMatchObject([
          { sessionId, cwd: workDir, title: "hello" },
        ]);

        await context.request(acp.methods.agent.session.load, {
          cwd: workDir,
          sessionId,
          mcpServers: [],
        });
        expect(runtimes[0]?.conv.getMessages()).toMatchObject([
          { role: "user", content: "hello" },
          { role: "assistant", content: "world" },
        ]);
        expect(
          updates.map((notification) => notification.update.sessionUpdate),
        ).toEqual(["user_message_chunk", "agent_message_chunk"]);
      });
    } finally {
      await implementation.dispose();
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
