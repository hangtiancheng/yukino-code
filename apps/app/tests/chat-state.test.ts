import assert from "node:assert/strict";
import { test } from "node:test";

import {
  chatReducer,
  initialChatState,
  type ChatItem,
  type ChatState,
} from "../src/renderer/src/lib/chat-state.ts";
import type { BridgeEvent, ToolContentBlock } from "../src/shared/ipc-types.ts";

type ToolItem = Extract<ChatItem, { kind: "tool" }>;
type UserItem = Extract<ChatItem, { kind: "user" }>;

const reduce = (events: BridgeEvent[]): ChatState =>
  events.reduce(
    (state, event) => chatReducer(state, { type: "event", event }),
    initialChatState,
  );

function toolItem(state: ChatState, index: number): ToolItem {
  const item = state.items[index];
  assert.ok(item?.kind === "tool");
  return item;
}

function userItem(state: ChatState, index: number): UserItem {
  const item = state.items[index];
  assert.ok(item?.kind === "user");
  return item;
}

void test("stopping a run settles every pending tool and streaming row", () => {
  const state = reduce([
    { type: "run_state", data: { streaming: true } },
    { type: "thinking_text", data: { text: "checking" } },
    { type: "tool_use", data: { toolId: "read", toolName: "Read", args: {} } },
    { type: "stream_text", data: { text: "partial" } },
    { type: "run_state", data: { streaming: false } },
  ]);
  assert.equal(state.streaming, false);
  assert.ok(
    state.items.every((item) =>
      item.kind === "tool"
        ? !item.running
        : item.kind === "assistant"
          ? !item.streaming
          : true,
    ),
  );
});

void test("preserves full tool output and structured image results", () => {
  const output = "a".repeat(12_000);
  const image: ToolContentBlock = {
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
  const item = toolItem(state, 0);
  assert.equal(item.output, output);
  assert.deepEqual(item.contentBlocks, [image]);
});

void test("session replay pairs tool results without showing tool carriers as user prompts", () => {
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
  assert.equal(toolItem(state, 1).output, "file body");
});

void test("resuming a session clears activity indicators from the previous session", () => {
  const state = reduce([
    {
      type: "subagent",
      data: {
        type: "started",
        toolCallId: "agent",
        role: "reviewer",
        background: true,
      },
    },
    { type: "history", data: { sessionId: "restored", messages: [] } },
  ]);
  assert.equal(state.activeSubagents, 0);
  assert.equal(state.activeSessionId, "restored");
});

void test("initialization failures stay in the recovery screen instead of accumulating chat errors", () => {
  const failure: BridgeEvent = {
    type: "init_state",
    data: { ok: false, kind: "project", error: "The project no longer exists" },
  };
  const state = reduce([failure, failure, failure]);
  assert.equal(state.items.length, 0);
  assert.equal(state.initializing, false);
});

void test("live shell output is replaced by the complete final result and keeps elapsed seconds", () => {
  const state = reduce([
    {
      type: "tool_use",
      data: { toolId: "shell", toolName: "Bash", args: { command: "pwd" } },
    },
    { type: "tool_output", data: { toolId: "shell", output: "first" } },
    { type: "tool_output", data: { toolId: "shell", output: " second" } },
    {
      type: "tool_result",
      data: {
        toolId: "shell",
        toolName: "Bash",
        output: "complete",
        isError: false,
        elapsed: 1.2,
      },
    },
  ]);
  const item = toolItem(state, 0);
  assert.equal(item.output, "complete");
  assert.equal(item.elapsed, 1.2);
  assert.equal(item.running, false);
});

void test("session replay restores excluded shell commands and structured tool content", () => {
  const image: ToolContentBlock = {
    type: "image",
    source: { type: "base64", data: "AA==", media_type: "image/png" },
  };
  const state = chatReducer(initialChatState, {
    type: "load_history",
    messages: [
      {
        role: "user",
        content: "shell context",
        timestamp: 0,
        userBash: {
          command: "pwd",
          output: "/project",
          isError: false,
          excludeFromContext: true,
          elapsed: 0.1,
          status: "completed",
        },
      },
      {
        role: "assistant",
        content: "",
        timestamp: 1,
        toolUses: [{ toolUseId: "read", toolName: "Read", arguments: {} }],
      },
      {
        role: "user",
        content: "",
        timestamp: 2,
        toolResults: [
          {
            toolUseId: "read",
            content: "image",
            isError: false,
            contentBlocks: [image],
          },
        ],
      },
    ],
  });
  assert.equal(userItem(state, 0).text, "!!pwd");
  assert.equal(toolItem(state, 1).output, "/project");
  assert.deepEqual(toolItem(state, 2).contentBlocks, [image]);
});
