import { describe, expect, it } from "vitest";

import {
  chatReducer,
  initialState,
} from "@/remote/browser/src/hooks/use-chat.js";

describe("browser transcript identity", () => {
  it("does not close a new plan approval when an older request settles", () => {
    const state = chatReducer(initialState, {
      kind: "message",
      message: {
        type: "plan_approval_request",
        data: {
          id: "new-plan",
          planPath: "/plan",
          planContent: "current plan",
        },
      },
    });
    const unchanged = chatReducer(state, {
      kind: "message",
      message: { type: "plan_approval_closed", data: { id: "old-plan" } },
    });
    expect(unchanged.planApproval?.id).toBe("new-plan");
    const settled = chatReducer(unchanged, {
      kind: "message",
      message: { type: "plan_approval_closed", data: { id: "new-plan" } },
    });
    expect(settled.planApproval).toBeNull();
  });
  it("deduplicates replayed questions and keeps the actual permission decision", () => {
    const request = {
      type: "permission_request",
      data: {
        id: "permission-1",
        toolName: "WriteFile",
        description: "write a file",
      },
    } as const;
    let state = chatReducer(initialState, {
      kind: "message",
      message: request,
    });
    state = chatReducer(state, { kind: "message", message: request });
    expect(
      state.items.filter((item) => item.kind === "permission"),
    ).toHaveLength(1);
    state = chatReducer(state, {
      kind: "message",
      message: {
        type: "request_expired",
        data: { id: "permission-1", kind: "permission", response: "allow" },
      },
    });
    expect(
      state.items.find((item) => item.kind === "permission"),
    ).toMatchObject({ responded: true, response: "allow" });
    const ask = {
      type: "ask_user" as const,
      data: { id: "ask-1", questions: [] },
    };
    state = chatReducer(state, { kind: "message", message: ask });
    state = chatReducer(state, { kind: "message", message: ask });
    expect(state.items.filter((item) => item.kind === "askUser")).toHaveLength(
      1,
    );
  });
  it("keeps the scroll reset identity when history rolls over", () => {
    let state = initialState;
    for (let index = 0; index <= 1000; index++) {
      state = chatReducer(state, {
        kind: "message",
        message: {
          type: "replay_user",
          data: { content: `message ${String(index)}` },
        },
      });
    }
    expect(state.items).toHaveLength(1000);
    expect(state.items[0]).toMatchObject({ content: "message 1" });
    expect(state.transcriptRevision).toBe(initialState.transcriptRevision);
    const cleared = chatReducer(state, {
      kind: "message",
      message: { type: "clear", data: null },
    });
    expect(cleared.transcriptRevision).toBe(state.transcriptRevision + 1);
    expect(cleared.items).toHaveLength(1);
    expect(cleared.currentAssistantId).toBeNull();
  });
});
