import assert from "node:assert/strict";
import { test } from "node:test";

import {
  chatReducer,
  initialChatState,
} from "../src/renderer/src/lib/chat-state.ts";

const reduce = (events) =>
  events.reduce(
    (state, event) => chatReducer(state, { type: "event", event }),
    initialChatState,
  );

test("stopping a run settles every pending tool and streaming row", () => {
  const state = reduce([
    { type: "run_state", data: { streaming: true } },
    { type: "thinking_text", data: { text: "checking" } },
    { type: "tool_use", data: { toolId: "read", toolName: "Read", args: {} } },
    { type: "stream_text", data: { text: "partial" } },
    { type: "run_state", data: { streaming: false } },
  ]);
  assert.equal(state.streaming, false);
  assert.ok(state.items.every((item) => !item.running && !item.streaming));
});

test("preserves full tool output and structured image results", () => {
  const output = "a".repeat(12000);
  const image = {
    type: "image",
    source: { type: "base64", data: "AA==", media_type: "image/png" },
  };
  const state = reduce([
    { type: "tool_use", data: { toolId: "tool", toolName: "Read", args: {} } },
    {
      type: "tool_result",
      data: {
        toolId: "tool",
        toolName: "Read",
        output,
        contentBlocks: [image],
        isError: false,
        elapsed: 5,
      },
    },
  ]);
  assert.equal(state.items[0].output, output);
  assert.deepEqual(state.items[0].contentBlocks, [image]);
});

test("session replay pairs tool results without showing tool carriers as user prompts", () => {
  const state = chatReducer(initialChatState, {
    type: "load_history",
    messages: [
      { role: "user", content: "inspect file", timestamp: 0 },
      {
        role: "assistant",
        content: "",
        timestamp: 1,
        toolUses: [
          {
            toolUseId: "read",
            toolName: "Read",
            arguments: { file_path: "a.ts" },
          },
        ],
      },
      {
        role: "user",
        content: "tool result",
        timestamp: 2,
        toolResults: [
          { toolUseId: "read", content: "file body", isError: false },
        ],
      },
    ],
  });
  assert.deepEqual(
    state.items.map((item) => item.kind),
    ["user", "tool"],
  );
  assert.equal(state.items[1].output, "file body");
});
