import { describe, expect, it } from "vitest";

import {
  chatReducer,
  initialState,
} from "@/remote/browser/src/hooks/use-chat.js";

describe("browser transcript identity", () => {
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
