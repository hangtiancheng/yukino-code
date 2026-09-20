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

import { render, type Instance } from "ink";
import { act, createElement, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentEvent } from "@/agent/events.js";
import type { ChatMessage } from "@/ui/chat.js";
import { useAgentOutput, type AgentCardDecoration } from "@/ui/use-agent-output.js";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const isPromise = (obj: unknown): obj is Promise<unknown> =>
  typeof obj === "object" && obj !== null && "then" in obj && typeof obj.then === "function";

let instance: Instance | undefined;
let current: { output: ReturnType<typeof useAgentOutput>; messages: ChatMessage[] } | undefined;

function Harness() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  current = { output: useAgentOutput(setMessages), messages };
  return null;
}

function state() {
  if (!current) {
    throw new Error("Output harness is not mounted");
  }
  return current;
}

function startLoop(resolveAgentCard?: (toolId: string) => AgentCardDecoration | undefined) {
  let handler: ((event: AgentEvent) => void) | undefined;
  act(() => {
    handler = state().output.createEventHandler(resolveAgentCard);
  });
  return (...events: AgentEvent[]) => {
    act(() => {
      for (const event of events) {
        handler?.(event);
      }
    });
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  act(() => {
    instance = render(createElement(Harness), {
      patchConsole: false,
      interactive: false,
    });
  });
});

afterEach(() => {
  act(() => {
    instance?.unmount();
    instance?.cleanup();
  });
  instance = undefined;
  current = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("agent output hook", () => {
  it("batches stream updates and commits once at turn and loop boundaries", () => {
    const send = startLoop();
    send({ type: "stream_text", text: "Hello" }, { type: "stream_text", text: " world" });
    expect(state().output.streamingText).toBe("");
    expect(state().output.streamingTextRef.current).toBe("Hello world");
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(state().output.streamingText).toBe("Hello world");
    send({ type: "turn_complete" }, { type: "loop_complete", stopReason: "end_turn" });
    expect(state().messages).toEqual([{ role: "assistant", content: "Hello world" }]);
    expect(state().output.streamingText).toBe("");
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(state().output.streamingText).toBe("");
  });

  it("keeps thinking, text, and parallel same-name tools in chronological groups", () => {
    const send = startLoop();
    send({ type: "thinking_text", text: "Reasoning" });
    vi.setSystemTime(2500);
    send(
      {
        type: "thinking_complete",
        thinking: "Reasoning",
        signature: "signature",
      },
      { type: "stream_text", text: "Checking" },
      {
        type: "tool_use",
        toolName: "Read",
        toolId: "a",
        args: { file_path: "a.ts" },
      },
      {
        type: "tool_use",
        toolName: "Read",
        toolId: "b",
        args: { file_path: "b.ts" },
      },
      {
        type: "tool_result",
        toolName: "Read",
        toolId: "b",
        output: "second",
        isError: true,
        elapsed: 2,
      },
    );
    expect(state().output.activeTools.map((tool) => [tool.toolId, tool.loading])).toEqual([
      ["a", true],
      ["b", false],
    ]);
    send(
      {
        type: "tool_result",
        toolName: "Read",
        toolId: "a",
        output: "first",
        isError: false,
        elapsed: 3,
      },
      { type: "turn_complete" },
    );
    expect(state().messages.slice(0, 2)).toEqual([
      { role: "turn_summary", content: "Reasoning", thinkingDuration: 1.5 },
      { role: "assistant", content: "Checking" },
    ]);
    expect(state().messages[2]?.toolSummary).toEqual([
      expect.objectContaining({
        output: "first",
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        argsSummary: expect.stringContaining("a.ts"),
        isError: false,
      }),
      expect.objectContaining({
        output: "second",
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        argsSummary: expect.stringContaining("b.ts"),
        isError: true,
      }),
    ]);
    expect(state().output.activeTools).toEqual([]);
    expect(state().output.streamingThinking).toBe("");
    send({ type: "stream_text", text: "Done" }, { type: "loop_complete", stopReason: "end_turn" });
    expect(state().messages.at(-1)).toEqual({
      role: "assistant",
      content: "Done",
    });
  });

  it("keeps successful teammate Agent cards dynamic instead of committing them", () => {
    const send = startLoop();
    send({
      type: "tool_use",
      toolName: "Agent",
      toolId: "team-agent",
      args: { description: "reviewer", team_name: "squad" },
    });
    expect(state().output.persistentAgentTools).toEqual([
      expect.objectContaining({ toolId: "team-agent", loading: true }),
    ]);

    send(
      {
        type: "tool_result",
        toolName: "Agent",
        toolId: "team-agent",
        output: "Teammate spawned",
        isError: false,
        elapsed: 0.2,
      },
      { type: "turn_complete" },
    );

    expect(state().output.activeTools).toEqual([]);
    expect(state().output.persistentAgentTools).toEqual([
      expect.objectContaining({
        toolId: "team-agent",
        output: "Teammate spawned",
        loading: false,
      }),
    ]);
    expect(state().messages.flatMap((message) => message.toolSummary ?? [])).toEqual([]);

    act(() => {
      state().output.resetUsage();
    });
    expect(state().output.persistentAgentTools).toEqual([]);
  });

  it("commits background Agent cards to history like plain tool calls", () => {
    const send = startLoop();
    send(
      {
        type: "tool_use",
        toolName: "Agent",
        toolId: "background-agent",
        args: {
          description: "background review",
          subagent_type: "explore",
          run_in_background: true,
        },
      },
      {
        type: "tool_result",
        toolName: "Agent",
        toolId: "background-agent",
        output: "Background agent started",
        isError: false,
        elapsed: 0.1,
      },
      { type: "turn_complete" },
    );

    // One-shot background calls must not stay pinned to the bottom: their
    // card scrolls away with the transcript like any other tool card, and
    // the result reaches the user as a task notification.
    expect(state().output.persistentAgentTools).toEqual([]);
    expect(state().messages.flatMap((message) => message.toolSummary ?? [])).toEqual([
      expect.objectContaining({
        toolName: "Agent",
        output: "Background agent started",
        isError: false,
      }),
    ]);
  });

  it("commits foreground Agent cards with the resolved subagent status", () => {
    const send = startLoop((toolId) =>
      toolId === "agent-stop"
        ? { status: "stopped", progress: "general-purpose subagent | 2 turns" }
        : toolId === "agent-done"
          ? { status: "completed", progress: "explore subagent | 3 turns" }
          : undefined,
    );
    send(
      {
        type: "tool_use",
        toolName: "Agent",
        toolId: "agent-stop",
        args: {
          description: "fix bug",
          prompt: "fix it",
          subagent_type: "general-purpose",
        },
      },
      {
        type: "tool_use",
        toolName: "Agent",
        toolId: "agent-done",
        args: {
          description: "survey code",
          prompt: "survey",
          subagent_type: "explore",
        },
      },
      {
        type: "tool_use",
        toolName: "Read",
        toolId: "read-1",
        args: { file_path: "a.ts" },
      },
      {
        type: "tool_result",
        toolName: "Agent",
        toolId: "agent-stop",
        output: "partial work\n\n[Interrupted]",
        isError: false,
        elapsed: 12,
      },
      {
        type: "tool_result",
        toolName: "Agent",
        toolId: "agent-done",
        output: "findings",
        isError: false,
        elapsed: 8,
      },
      {
        type: "tool_result",
        toolName: "Read",
        toolId: "read-1",
        output: "contents",
        isError: false,
        elapsed: 1,
      },
    );

    // The interrupted card must not look like a success: status drives the
    // red "stopped" styling, matching the persistent background cards.
    const stopped = state().output.activeTools.find((tool) => tool.toolId === "agent-stop");
    expect(stopped).toEqual(
      expect.objectContaining({
        status: "stopped",
        progress: "general-purpose subagent | 2 turns",
        loading: false,
      }),
    );
    // Non-Agent tools never receive a decoration, even with a resolver active.
    const read = state().output.activeTools.find((tool) => tool.toolId === "read-1");
    expect(read?.status).toBeUndefined();
    expect(read?.progress).toBeUndefined();

    send({ type: "turn_complete" });
    const summary = state().messages.at(-1)?.toolSummary ?? [];
    expect(summary[0]).toEqual(
      expect.objectContaining({
        toolName: "Agent",
        status: "stopped",
        progress: "general-purpose subagent | 2 turns",
        output: "partial work\n\n[Interrupted]",
        isError: false,
      }),
    );
    expect(summary[1]).toEqual(
      expect.objectContaining({
        toolName: "Agent",
        status: "completed",
        progress: "explore subagent | 3 turns",
      }),
    );
    expect(summary[2]?.status).toBeUndefined();
    expect(summary[2]?.progress).toBeUndefined();
  });

  it("removes every persistent card for a deleted team", () => {
    const send = startLoop();
    for (const [toolId, teamName] of [
      ["a-1", "alpha"],
      ["a-2", "alpha"],
      ["b-1", "beta"],
    ]) {
      send(
        {
          type: "tool_use",
          toolName: "Agent",
          toolId,
          args: { description: toolId, team_name: teamName },
        },
        {
          type: "tool_result",
          toolName: "Agent",
          toolId,
          output: "Teammate spawned",
          isError: false,
          elapsed: 0.1,
        },
      );
    }

    send(
      {
        type: "tool_use",
        toolName: "TeamDelete",
        toolId: "delete",
        args: { name: "alpha" },
      },
      {
        type: "tool_result",
        toolName: "TeamDelete",
        toolId: "delete",
        output: "Team deleted",
        isError: false,
        elapsed: 0.1,
      },
    );

    expect(state().output.persistentAgentTools.map((tool) => tool.toolId)).toEqual(["b-1"]);
  });

  it("clears every pinned teammate card when TeamCreate succeeds", () => {
    const send = startLoop();
    for (const toolId of ["a-1", "a-2"]) {
      send(
        {
          type: "tool_use",
          toolName: "Agent",
          toolId,
          args: { description: toolId, team_name: "alpha" },
        },
        {
          type: "tool_result",
          toolName: "Agent",
          toolId,
          output: "Teammate spawned",
          isError: false,
          elapsed: 0.1,
        },
      );
    }
    expect(state().output.persistentAgentTools.map((tool) => tool.toolId)).toEqual(["a-1", "a-2"]);

    // TeamCreate deletes every existing team, so all pinned cards are stale.
    send(
      {
        type: "tool_use",
        toolName: "TeamCreate",
        toolId: "create",
        args: { team_name: "beta" },
      },
      {
        type: "tool_result",
        toolName: "TeamCreate",
        toolId: "create",
        output: "Team 'beta' created",
        isError: false,
        elapsed: 0.1,
      },
    );

    expect(state().output.persistentAgentTools).toEqual([]);
    // The TeamCreate call itself still commits to history like a normal tool.
    expect(state().messages.flatMap((message) => message.toolSummary ?? [])).toEqual([]);
    send({ type: "turn_complete" });
    expect(
      state()
        .messages.flatMap((message) => message.toolSummary ?? [])
        .map((tool) => tool.toolName),
    ).toEqual(["TeamCreate"]);
  });

  it("keeps retry, compaction, and token accounting without dropping pending text", () => {
    const send = startLoop();
    send(
      { type: "stream_text", text: "partial" },
      { type: "retry", reason: "busy", delay: 2000 },
      { type: "compact", message: "Context compacted" },
      {
        type: "usage",
        usage: {
          inputTokens: 10,
          outputTokens: 4,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
      {
        type: "usage",
        usage: {
          inputTokens: 20,
          outputTokens: 6,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
      { type: "loop_complete", stopReason: "end_turn" },
    );
    expect(state().messages.map((message) => message.content)).toEqual([
      "↻ busy (waiting 2s)",
      "⊙ Context compacted",
      "partial",
    ]);
    expect(state().output.inputTokens).toBe(30);
    expect(state().output.outputTokens).toBe(10);
    act(() => {
      state().output.resetUsage();
    });
    expect(state().output.inputTokens).toBe(0);
    expect(state().output.outputTokens).toBe(0);
  });

  it("retains partial text for abort/error handling and cancels late flushes", () => {
    const send = startLoop();
    send(
      { type: "stream_text", text: "unfinished" },
      { type: "error", error: new Error("offline") },
    );
    act(() => {
      state().output.finishTurn();
    });
    expect(state().output.streamingTextRef.current).toBe("unfinished");
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(state().output.streamingText).toBe("");
    const next = startLoop();
    next(
      { type: "stream_text", text: "new turn" },
      { type: "loop_complete", stopReason: "end_turn" },
    );
    expect(state().messages).toEqual([{ role: "assistant", content: "new turn" }]);
  });

  it("shows retry feedback until output resumes or the turn ends", () => {
    const send = startLoop();
    send({ type: "retry", reason: "busy", delay: 2000 });
    expect(state().output.retryStatus).toBe("Retrying (2s delay): busy");
    send({ type: "stream_text", text: "resumed" });
    expect(state().output.retryStatus).toBeUndefined();
    send({ type: "retry", reason: "busy", delay: 0 });
    act(() => {
      state().output.finishTurn();
    });
    expect(state().output.retryStatus).toBeUndefined();
  });

  it("cancels a scheduled stream flush when unmounted", () => {
    const send = startLoop();
    send({ type: "stream_text", text: "pending" });
    const clearTimeout = vi.spyOn(globalThis, "clearTimeout");
    act(() => {
      instance?.unmount();
    });
    expect(clearTimeout).toHaveBeenCalled();
  });

  it("commits thinking and completed tools once when a loop ends without turn_complete", () => {
    const send = startLoop();
    send(
      { type: "thinking_text", text: "Investigating" },
      { type: "stream_text", text: "Partial response" },
      {
        type: "tool_use",
        toolId: "read",
        toolName: "Read",
        args: { file_path: "a.ts" },
      },
      {
        type: "tool_result",
        toolId: "read",
        toolName: "Read",
        output: "saved",
        isError: false,
        elapsed: 1,
      },
      { type: "loop_complete", stopReason: "interrupted" },
      { type: "loop_complete", stopReason: "interrupted" },
    );
    expect(state().messages.map((message) => message.content)).toEqual([
      "Investigating",
      "Partial response",
      "",
    ]);
    expect(state().messages.at(-1)?.toolSummary?.[0].output).toBe("saved");
    expect(state().output.activeTools).toEqual([]);
    expect(state().output.streamingTextRef.current).toBe("");
  });
});
