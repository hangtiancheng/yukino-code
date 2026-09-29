import { describe, expect, it } from "vitest";

import { isServerMessage, type ServerMessage } from "@/remote/fe/src/types.js";

const validMessages: Record<ServerMessage["type"], ServerMessage> = {
  connected: { type: "connected", data: { session: "s1", cwd: "/repo" } },
  commands: {
    type: "commands",
    data: [{ name: "compact", description: "Compact context" }],
  },
  status: {
    type: "status",
    data: {
      model: "model-a",
      permissionMode: "default",
      thinkingLevel: "high",
    },
  },
  system: { type: "system", data: { message: "ready" } },
  clear: { type: "clear", data: null },
  command_done: { type: "command_done", data: null },
  replay_user: { type: "replay_user", data: { content: "question" } },
  replay_assistant: {
    type: "replay_assistant",
    data: { content: "answer" },
  },
  stream_text: { type: "stream_text", data: { text: "partial" } },
  stream_end: { type: "stream_end", data: { text: "complete" } },
  thinking_text: { type: "thinking_text", data: { text: "reasoning" } },
  tool_use: {
    type: "tool_use",
    data: { toolId: "t1", toolName: "Read", args: { path: "a.ts" } },
  },
  tool_result: {
    type: "tool_result",
    data: {
      toolId: "t1",
      toolName: "Read",
      output: "contents",
      isError: false,
      elapsed: 0.25,
    },
  },
  permission_request: {
    type: "permission_request",
    data: { id: "p1", toolName: "Write", description: "write a.ts" },
  },
  ask_user: {
    type: "ask_user",
    data: {
      id: "q1",
      questions: [
        {
          question: "Continue?",
          header: "Confirm",
          options: [{ label: "Yes", description: "Continue" }],
          multiSelect: false,
        },
      ],
    },
  },
  plan_approval_request: {
    type: "plan_approval_request",
    data: { planPath: "/tmp/plan", planContent: "steps" },
  },
  session_list: {
    type: "session_list",
    data: {
      sessions: [
        {
          id: "s1",
          firstMessage: "hello",
          messageCount: 2,
          modTime: "2026-09-29T00:00:00.000Z",
        },
      ],
    },
  },
  code_review_form: { type: "code_review_form", data: null },
  code_review_progress: {
    type: "code_review_progress",
    data: { phase: "review", message: "checking", progress: 0.5 },
  },
  steering_queued: { type: "steering_queued", data: { text: "also check b" } },
  steering_delivered: {
    type: "steering_delivered",
    data: { text: "also check b" },
  },
  turn_complete: { type: "turn_complete", data: { turn: 1 } },
  loop_complete: {
    type: "loop_complete",
    data: { stopReason: "end_turn", totalTurns: 1, elapsed: 1.5 },
  },
  usage: { type: "usage", data: { inputTokens: 10, outputTokens: 5 } },
  error: { type: "error", data: { message: "failed" } },
  compact: { type: "compact", data: { message: "compacted" } },
  retry: { type: "retry", data: { reason: "busy", waitMs: 1000 } },
  pong: { type: "pong", data: null },
};

describe("server WebSocket message validation", () => {
  it("accepts every server message variant", () => {
    for (const message of Object.values(validMessages)) {
      expect(isServerMessage(message), message.type).toBe(true);
    }
  });

  it("accepts ask-user options without descriptions", () => {
    expect(
      isServerMessage({
        type: "ask_user",
        data: {
          id: "q2",
          questions: [
            {
              question: "Continue?",
              header: "Confirm",
              options: [{ label: "Yes" }],
              multiSelect: false,
            },
          ],
        },
      }),
    ).toBe(true);
  });

  it("rejects missing and wrong payloads for every variant", () => {
    for (const message of Object.values(validMessages)) {
      expect(isServerMessage({ type: message.type }), message.type).toBe(false);
      const wrongData = message.data === null ? {} : null;
      expect(
        isServerMessage({ type: message.type, data: wrongData }),
        message.type,
      ).toBe(false);
    }
  });

  it.each([
    { type: "connected", data: { session: "s1" } },
    {
      type: "commands",
      data: [{ name: "compact", description: 42 }],
    },
    {
      type: "tool_result",
      data: {
        toolId: "t1",
        toolName: "Read",
        output: "ok",
        isError: "false",
        elapsed: 1,
      },
    },
    {
      type: "ask_user",
      data: {
        id: "q1",
        questions: [
          {
            question: "Continue?",
            header: "Confirm",
            options: [],
          },
        ],
      },
    },
    { type: "retry", data: { reason: "busy", waitMs: "1000" } },
    { type: "pong", data: null, unexpected: true },
  ])("rejects a malformed nested frame %#", (message) => {
    expect(isServerMessage(message)).toBe(false);
  });
});
