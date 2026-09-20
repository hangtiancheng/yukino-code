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

import { describe, it, expect } from "vitest";

import { ConversationManager } from "@/conversation/index.js";
import { buildAnthropicMessages, markLastUserTailForCache } from "@/llm/anthropic.js";
import { buildOpenAIInput } from "@/llm/openai.js";
import { asRecord, strArg } from "@/utils/index.js";

describe("ConversationManager", () => {
  it("adds and retrieves messages", () => {
    const mgr = new ConversationManager();
    mgr.addUserMessage("hello");
    mgr.addAssistantMessage("hi there");
    expect(mgr.len()).toBe(2);

    const msgs = mgr.getMessages();
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toBe("hello");
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[1].content).toBe("hi there");
  });

  it("adds tool use and tool result messages", () => {
    const mgr = new ConversationManager();
    mgr.addToolUseMessage("let me read", "tu-1", "ReadFile", {
      file_path: "/test",
    });
    mgr.addToolResultMessage("tu-1", "file content here", false);

    const msgs = mgr.getMessages();
    expect(msgs[0].toolUses).toHaveLength(1);
    expect(msgs[0].toolUses?.[0].toolName).toBe("ReadFile");
    expect(msgs[1].toolResults).toHaveLength(1);
    expect(msgs[1].toolResults?.[0].content).toBe("file content here");
  });

  it("adds assistant full with thinking and tool uses", () => {
    const mgr = new ConversationManager();
    mgr.addAssistantFull(
      "response text",
      [{ thinking: "let me think...", signature: "sig1" }],
      [{ toolUseId: "tu-1", toolName: "Bash", arguments: { command: "ls" } }],
    );

    const msg = mgr.getMessages()[0];
    expect(msg.thinkingBlocks).toHaveLength(1);
    expect(msg.toolUses).toHaveLength(1);
  });

  it("truncates history", () => {
    const mgr = new ConversationManager();
    mgr.addUserMessage("1");
    mgr.addAssistantMessage("2");
    mgr.addUserMessage("3");
    mgr.truncateTo(1);
    expect(mgr.len()).toBe(1);
    expect(mgr.getMessages()[0].content).toBe("1");
  });

  it("injects long-term memory only once", () => {
    const mgr = new ConversationManager();
    mgr.addUserMessage("hello");
    mgr.injectLongTermMemory("# Instructions\nDo stuff", "");
    mgr.injectLongTermMemory("# Instructions\nDo stuff again", "");
    expect(mgr.len()).toBe(2); // original + injected, not 3
    expect(mgr.getMessages()[0].content).toContain("system-reminder");
  });

  // The skill listing is project-scoped, so it must live in the first system-reminder
  // rather than the system prompt — otherwise each project gets its own system prompt
  // and cross-project prompt caching breaks entirely.
  it("carries the skill listing in the injected message", () => {
    const mgr = new ConversationManager();
    mgr.addUserMessage("hello");
    mgr.injectLongTermMemory("rules", "mems", "- /pdf: fill forms");

    const injected = mgr.getMessages()[0].content;
    expect(injected).toContain("Available Skills");
    expect(injected).toContain("- /pdf: fill forms");
    // All three sections share one message at fixed positions to keep the cache prefix stable
    expect(injected).toContain("rules");
    expect(injected).toContain("mems");
    expect(mgr.getMessages()[1].content).toBe("hello");
  });

  // A project may have no AGENTS.md and no memories — injection should still happen when only skills are present
  it("injects when only skills are present", () => {
    const mgr = new ConversationManager();
    mgr.injectLongTermMemory("", "", "- /review: review code");

    expect(mgr.len()).toBe(1);
    expect(mgr.getMessages()[0].content).toContain("- /review: review code");
  });

  it("injects nothing when all three are empty", () => {
    const mgr = new ConversationManager();
    mgr.injectLongTermMemory("", "", "");
    expect(mgr.len()).toBe(0);
  });

  // /clear resets behind the same object: AgentTool captures the manager for its
  // fork path, so swapping the instance would strand it on the old history.
  it("empties history and the usage anchor in place on reset", () => {
    const mgr = new ConversationManager();
    mgr.addUserMessage("hello");
    mgr.addAssistantMessage("hi there");
    mgr.recordUsageAnchor(100, 50, 0, 0);
    expect(mgr.usageAnchorState()).not.toBeNull();

    mgr.reset();

    expect(mgr.len()).toBe(0);
    expect(mgr.getMessages()).toEqual([]);
    expect(mgr.usageAnchorState()).toBeNull();
  });

  it("allows long-term memory to be re-injected after a reset", () => {
    const mgr = new ConversationManager();
    mgr.injectLongTermMemory("rules", "mems");
    expect(mgr.len()).toBe(1);

    mgr.reset();
    mgr.injectLongTermMemory("rules", "mems");

    expect(mgr.len()).toBe(1);
    expect(mgr.getMessages()[0].content).toContain("rules");
  });

  describe("buildAnthropicMessages", () => {
    it("does not mutate attachment history when merging reminders or marking the cache tail", () => {
      const mgr = new ConversationManager();
      mgr.addUserMessage([
        { type: "text", text: "Inspect the attachment" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "QUJD" },
        },
      ]);
      mgr.addSystemReminder("Project instructions");
      const before = structuredClone(mgr.getMessages());
      const first = buildAnthropicMessages(mgr.getMessages());
      markLastUserTailForCache(first);
      const second = buildAnthropicMessages(mgr.getMessages());
      markLastUserTailForCache(second);
      expect(second).toEqual(first);
      expect(mgr.getMessages()).toEqual(before);
    });
    it("serializes tool use messages", () => {
      const mgr = new ConversationManager();
      mgr.addToolUseMessage("text", "tu-1", "Bash", { command: "ls" });
      const result = buildAnthropicMessages(mgr.getMessages());
      expect(result).toHaveLength(1);
      expect(result[0].role).toBe("assistant");
      const content = result[0].content;
      expect(content).toHaveLength(2);
      expect(strArg(asRecord(content[0]), "type")).toBe("text");
      expect(strArg(asRecord(content[1]), "type")).toBe("tool_use");
    });

    it("serializes tool result messages", () => {
      const mgr = new ConversationManager();
      mgr.addToolResultMessage("tu-1", "output", false);
      const result = buildAnthropicMessages(mgr.getMessages());
      expect(result).toHaveLength(1);
      const content = result[0].content;
      expect(strArg(asRecord(content[0]), "type")).toBe("tool_result");
      expect(strArg(asRecord(content[0]), "tool_use_id")).toBe("tu-1");
    });

    it("preserves signed thinking blocks at the head of the assistant message", () => {
      const mgr = new ConversationManager();
      mgr.addAssistantFull(
        "answer",
        [{ thinking: "let me think", signature: "sig-1" }],
        [{ toolUseId: "tu-1", toolName: "Bash", arguments: { command: "ls" } }],
      );
      const result = buildAnthropicMessages(mgr.getMessages());
      expect(result).toHaveLength(1);
      const content = result[0].content;
      expect(strArg(asRecord(content[0]), "type")).toBe("thinking");
      expect(strArg(asRecord(content[0]), "signature")).toBe("sig-1");
      expect(strArg(asRecord(content[content.length - 1]), "type")).toBe("tool_use");
    });

    it("passes user image content blocks through and merges them into a previous user turn", () => {
      const mgr = new ConversationManager();
      mgr.addUserMessage("first");
      mgr.addUserMessage([
        { type: "text", text: "look at this" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "QUJD" },
        },
      ]);
      const result = buildAnthropicMessages(mgr.getMessages());
      // Consecutive user turns merge into one entry with text + image blocks.
      expect(result).toHaveLength(1);
      expect(result[0].role).toBe("user");
      const content = result[0].content;
      expect(content).toHaveLength(3);
      expect(strArg(asRecord(content[0]), "type")).toBe("text");
      expect(strArg(asRecord(content[1]), "type")).toBe("text");
      expect(strArg(asRecord(content[2]), "type")).toBe("image");
    });

    it("still merges a following text-only user after an image-carrying user", () => {
      const mgr = new ConversationManager();
      mgr.addUserMessage([
        { type: "text", text: "with image" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "QUJD" },
        },
      ]);
      mgr.addUserMessage("follow-up");
      const result = buildAnthropicMessages(mgr.getMessages());
      expect(result).toHaveLength(1);
      const content = result[0].content;
      expect(Array.isArray(content) ? content.map((b) => asRecord(b).type) : []).toEqual([
        "text",
        "image",
        "text",
      ]);
    });

    it("embeds tool_result image blocks as a content block array", () => {
      const mgr = new ConversationManager();
      mgr.addToolResultMessage("tu-1", "[Image: shot.png]", false, [
        { type: "text", text: "[Image: shot.png]" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "QUJD" },
        },
      ]);
      const result = buildAnthropicMessages(mgr.getMessages());
      const block = asRecord(result[0].content[0]);
      expect(strArg(block, "type")).toBe("tool_result");
      const inner = block.content;
      expect(Array.isArray(inner) ? inner.map((b) => asRecord(b).type) : []).toEqual([
        "text",
        "image",
      ]);
    });

    it("passes native tool references through without duplicating the fallback", () => {
      const mgr = new ConversationManager();
      mgr.addToolResultMessage("tu-search", "Loaded mcp__linear__create_issue", false, [
        { type: "tool_reference", tool_name: "mcp__linear__create_issue" },
      ]);

      const result = buildAnthropicMessages(mgr.getMessages());
      const block = asRecord(result[0].content[0]);
      expect(block.content).toEqual([
        { type: "tool_reference", tool_name: "mcp__linear__create_issue" },
      ]);
      expect(JSON.stringify(block.content)).not.toContain("Loaded mcp__linear__create_issue");
    });

    it("marks the last non-image block for caching, not the trailing image", () => {
      const mgr = new ConversationManager();
      mgr.addUserMessage([
        { type: "text", text: "prompt" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "QUJD" },
        },
      ]);
      const messages = buildAnthropicMessages(mgr.getMessages());
      markLastUserTailForCache(messages);
      const content = messages[0].content;
      if (typeof content === "string") {
        throw new Error("expected blocks");
      }
      expect(asRecord(content[0]).cache_control).toEqual({ type: "ephemeral" });
      expect(asRecord(content[1]).cache_control).toBeUndefined();
    });

    it("falls back to the trailing image when every block is an image", () => {
      const messages: Parameters<typeof markLastUserTailForCache>[0] = [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "QUJD" },
            },
          ],
        },
      ];
      markLastUserTailForCache(messages);
      const content = messages[0].content;
      if (typeof content === "string") {
        throw new Error("expected blocks");
      }
      expect(asRecord(content[0]).cache_control).toEqual({ type: "ephemeral" });
    });
  });

  describe("buildOpenAIInput", () => {
    it("serializes tool uses as function_call", () => {
      const mgr = new ConversationManager();
      mgr.addToolUseMessage("text", "tu-1", "Bash", { command: "ls" });
      const result = buildOpenAIInput(mgr.getMessages());
      expect(result).toHaveLength(2); // text msg + function_call
      expect(strArg(asRecord(result[0]), "role")).toBe("assistant");
      expect(strArg(asRecord(result[1]), "type")).toBe("function_call");
      expect(strArg(asRecord(result[1]), "name")).toBe("Bash");
      expect(strArg(asRecord(result[1]), "arguments")).toBe('{"command":"ls"}');
    });

    it("serializes tool results as function_call_output", () => {
      const mgr = new ConversationManager();
      mgr.addToolResultMessage("tu-1", "output", false);
      const result = buildOpenAIInput(mgr.getMessages());
      expect(strArg(asRecord(result[0]), "type")).toBe("function_call_output");
      expect(strArg(asRecord(result[0]), "output")).toBe("output");
    });

    it("round-trips native computer calls and screenshot outputs", () => {
      const result = buildOpenAIInput([
        {
          role: "assistant",
          content: "",
          toolUses: [
            {
              toolUseId: "call_1",
              providerItemId: "item_1",
              toolName: "ComputerUse",
              arguments: {
                actions: [
                  { type: "move", x: 10, y: 20 },
                  { type: "scroll", x: 10, y: 20, scrollX: 30, scrollY: -40 },
                ],
                pendingSafetyChecks: [{ id: "check_1", code: "navigation" }],
                status: "in_progress",
              },
            },
          ],
        },
        {
          role: "user",
          content: "",
          toolResults: [
            {
              toolUseId: "call_1",
              content: "Screenshot 800x600.",
              contentBlocks: [
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/png", data: "QUJD" },
                },
              ],
              isError: false,
            },
          ],
        },
      ]);

      expect(result).toEqual([
        {
          type: "computer_call",
          id: "item_1",
          call_id: "call_1",
          status: "in_progress",
          actions: [
            { type: "move", x: 10, y: 20 },
            { type: "scroll", x: 10, y: 20, scroll_x: 30, scroll_y: -40 },
          ],
          pending_safety_checks: [{ id: "check_1", code: "navigation" }],
        },
        {
          type: "computer_call_output",
          call_id: "call_1",
          output: {
            type: "computer_screenshot",
            image_url: "data:image/png;base64,QUJD",
          },
          acknowledged_safety_checks: [{ id: "check_1", code: "navigation" }],
        },
      ]);
    });
  });
});
