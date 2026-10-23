import {
  isServerMessage,
  type ServerMessage,
} from "@yukino.js/remote-browser/types.js";
import { PRIVATE_BOARD_ID_PREFIX } from "@yukino.js/todo/constants.js";
import { describe, expect, it } from "vitest";

const validMessages: Record<ServerMessage["type"], ServerMessage> = {
  mcp_app_response: {
    type: "mcp_app_response",
    data: { requestId: "r1", result: {} },
  },
  connected: {
    type: "connected",
    data: { session: "s1", cwd: "/repo", streaming: false },
  },
  commands: {
    type: "commands",
    data: [{ name: "compact", description: "Compact context" }],
  },
  status: {
    type: "status",
    data: {
      model: "model-a",
      provider: "provider-a",
      permissionMode: "default",
      thinkingLevel: "high",
      thinkingLevels: ["off", "low", "high"],
      sandboxEnabled: false,
      sandboxAutoAllow: false,
      contextWindow: 200000,
    },
  },
  system: { type: "system", data: { message: "ready" } },
  clear: { type: "clear", data: null },
  command_done: { type: "command_done", data: null },
  run_state: { type: "run_state", data: { streaming: true } },
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
  request_expired: {
    type: "request_expired",
    data: { id: "p1", kind: "permission" },
  },
  ask_user: {
    type: "ask_user",
    data: {
      id: "q1",
      questions: [
        {
          question: "Continue?",
          options: [{ label: "Yes", description: "Continue" }],
          multiSelect: false,
        },
      ],
    },
  },
  plan_approval_closed: {
    type: "plan_approval_closed",
    data: { id: "plan-1" },
  },
  plan_approval_request: {
    type: "plan_approval_request",
    data: { id: "plan-1", planPath: "/tmp/plan", planContent: "steps" },
  },
  session_list: {
    type: "session_list",
    data: {
      sessions: [
        {
          id: "s1",
          firstMessage: "hello",
          messageCount: 2,
          lastUserMessageTime: "2026-09-29T00:00:00.000Z",
        },
      ],
    },
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
  usage: {
    type: "usage",
    data: {
      inputTokens: 10,
      outputTokens: 5,
      contextTokens: 1200,
      contextWindow: 200000,
    },
  },
  error: { type: "error", data: { message: "failed" } },
  compact: { type: "compact", data: { message: "compacted" } },
  retry: { type: "retry", data: { reason: "busy", waitMs: 1000 } },
  pong: { type: "pong", data: null },
  history: { type: "history", data: { entries: ["hello", "world"] } },
  todo_update: {
    type: "todo_update",
    data: {
      boardId: `${PRIVATE_BOARD_ID_PREFIX}0`,
      tasks: [{ id: "1", subject: "task", status: "pending" }],
    },
  },
  subagents: {
    type: "subagents",
    data: {
      list: [
        {
          toolCallId: "call-1",
          role: "explorer",
          background: false,
          turnCount: 2,
          status: "running",
          activeTools: [{ toolId: "t1", toolName: "Read" }],
        },
      ],
    },
  },
  background_tasks: {
    type: "background_tasks",
    data: {
      list: [
        { id: "agent-1", name: "build", kind: "shell", status: "running" },
      ],
    },
  },
  teammates: {
    type: "teammates",
    data: {
      list: [
        {
          name: "alice",
          teamName: "alpha",
          status: "running",
          spinnerVerb: "writing",
          lastMessage: null,
          turnCount: 3,
          toolUseCount: 7,
          tokenCount: 1200,
          activeTools: [{ toolId: "t2", toolName: "Write" }],
        },
      ],
    },
  },
  model_list: {
    type: "model_list",
    data: {
      status: "ready",
      models: [{ id: "model-a", name: null }],
      current: "model-a",
    },
  },
  provider_list: {
    type: "provider_list",
    data: {
      providers: [
        {
          name: "p1",
          protocol: "openai",
          base_url: "https://api.example.com",
          model: "model-a",
        },
      ],
      current: 0,
    },
  },
  rewind_list: {
    type: "rewind_list",
    data: {
      snapshots: [
        {
          index: 0,
          id: "2026-10-01T00:00:00.000Z",
          userText: "fix the bug",
          timestamp: "2026-10-01T00:00:00.000Z",
          fileCount: 2,
        },
      ],
    },
  },
  thinking_form: {
    type: "thinking_form",
    data: { current: "high", levels: ["off", "high"] },
  },
  file_complete_response: {
    type: "file_complete_response",
    data: { requestId: "at-1", matches: ["src/a.ts"] },
  },
  image_saved: {
    type: "image_saved",
    data: { clientId: "img-1", path: "/tmp/upload.png" },
  },
  image_error: {
    type: "image_error",
    data: { clientId: "img-2", message: "too large" },
  },
  followups: { type: "followups", data: { list: ["queued message"] } },
  tool_output: {
    type: "tool_output",
    data: { toolId: "user-bash-1", output: "partial" },
  },
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
