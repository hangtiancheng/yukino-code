import { Message, Role, TaskState } from "@a2a-js/sdk";
import type { Part } from "@a2a-js/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  agentEventToMessage,
  findPermissionResponse,
  MAX_TOOL_OUTPUT_LENGTH,
  messageText,
  statusUpdate,
  taskSnapshot,
  textPart,
} from "@/a2a/conversion.js";

function message(parts: Part[]) {
  return {
    messageId: "m1",
    contextId: "c1",
    taskId: "t1",
    role: Role.ROLE_USER,
    parts,
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

describe("A2A conversion", () => {
  it("extracts text from message parts", () => {
    expect(
      messageText(
        message([
          textPart("hello"),
          {
            content: { $case: "data", value: { ignored: true } },
            metadata: undefined,
            filename: "",
            mediaType: "application/json",
          },
          textPart("world"),
        ]),
      ),
    ).toBe("hello\n\nworld");
    expect(messageText(message([]))).toBe("");
  });

  it("finds yukino permission-response data parts", () => {
    const response = findPermissionResponse(
      message([
        textPart("ignored"),
        {
          content: {
            $case: "data",
            value: {
              yukino: "permission-response",
              permissionId: "perm-1",
              decision: "allowAlways",
            },
          },
          metadata: undefined,
          filename: "",
          mediaType: "application/json",
        },
      ]),
    );
    expect(response).toEqual({
      yukino: "permission-response",
      permissionId: "perm-1",
      decision: "allowAlways",
    });

    expect(
      findPermissionResponse(
        message([
          {
            content: { $case: "data", value: { yukino: "other" } },
            metadata: undefined,
            filename: "",
            mediaType: "application/json",
          },
        ]),
      ),
    ).toBeNull();
  });

  it("maps agent events to A2A messages", () => {
    const text = agentEventToMessage(
      { type: "stream_text", text: "hi" },
      "t1",
      "c1",
    );
    expect(text?.parts[0]?.content).toEqual({ $case: "text", value: "hi" });

    const toolCall = agentEventToMessage(
      { type: "tool_use", toolName: "Bash", toolId: "tc1", args: { a: 1 } },
      "t1",
      "c1",
    );
    const callContent = toolCall?.parts[0]?.content;
    expect(callContent?.$case).toBe("data");
    if (callContent?.$case === "data") {
      expect(callContent.value).toMatchObject({
        yukino: "tool-call",
        toolCallId: "tc1",
        toolName: "Bash",
        args: { a: 1 },
      });
    }

    const longOutput = "x".repeat(MAX_TOOL_OUTPUT_LENGTH + 100);
    const toolResult = agentEventToMessage(
      {
        type: "tool_result",
        toolName: "Bash",
        toolId: "tc1",
        output: longOutput,
        isError: false,
        elapsed: 1,
      },
      "t1",
      "c1",
    );
    const resultContent = toolResult?.parts[0]?.content;
    if (resultContent?.$case === "data") {
      const value = z.object({ output: z.string() }).parse(resultContent.value);
      expect(value.output.length).toBeLessThan(longOutput.length);
      expect(value.output).toContain("[truncated]");
    } else {
      expect.unreachable();
    }

    expect(
      agentEventToMessage({ type: "turn_complete" }, "t1", "c1"),
    ).toBeNull();
  });

  it("builds status updates and task snapshots that serialize to the wire format", () => {
    const update = statusUpdate(
      "t1",
      "c1",
      TaskState.TASK_STATE_WORKING,
      Message.fromJSON({
        messageId: "m1",
        taskId: "t1",
        contextId: "c1",
        role: "ROLE_AGENT",
        parts: [{ text: "progress" }],
      }),
    );
    expect(update.status?.state).toBe(TaskState.TASK_STATE_WORKING);
    const serialized = JSON.stringify(update);
    expect(serialized).toContain("progress");

    const snapshot = taskSnapshot("t1", "c1", TaskState.TASK_STATE_SUBMITTED);
    expect(snapshot.id).toBe("t1");
    expect(snapshot.status?.state).toBe(TaskState.TASK_STATE_SUBMITTED);
    expect(snapshot.artifacts).toEqual([]);
    expect(snapshot.history).toEqual([]);
  });
});
