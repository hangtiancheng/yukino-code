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
import z, { parse, safeParse } from "zod";

import type { Message } from "@/conversation/index.js";
import { buildChatCompletionMessages, buildOpenAIInput } from "@/llm/openai.js";

describe("openai-compat chat message building", () => {
  it("attaches reasoning_content to the assistant message alongside tool_calls", () => {
    const messages = buildChatCompletionMessages([
      {
        role: "assistant",
        content: "",
        thinkingBlocks: [{ thinking: "Check the file first", signature: "" }],
        toolUses: [
          {
            toolUseId: "r1",
            toolName: "ReadFile",
            arguments: { file_path: "a.ts" },
          },
        ],
      },
    ]);
    expect(messages[0]).toMatchObject({
      reasoning_content: "Check the file first",
    });
    expect(messages[0]).toMatchObject({ tool_calls: [{ id: "r1" }] });
  });
  it("preserves assistant tool_calls and tool-result turns", () => {
    const history: Message[] = [
      { role: "user", content: "list files" },
      {
        role: "assistant",
        content: "",
        toolUses: [{ toolUseId: "c1", toolName: "Bash", arguments: { command: "ls" } }],
      },
      {
        role: "user",
        content: "",
        toolResults: [{ toolUseId: "c1", content: "a.txt", isError: false }],
      },
      { role: "assistant", content: "Found a.txt" },
    ];

    const msgs = buildChatCompletionMessages(history);

    const AssistantWithToolsSchema = z.looseObject({
      tool_calls: z.array(
        z.looseObject({
          id: z.string(),
          function: z.looseObject({
            name: z.string(),
            arguments: z.string(),
          }),
        }),
      ),
    });

    const ToolMessageSchema = z.looseObject({
      tool_call_id: z.string(),
      content: z.string(),
    });

    const assistantWithTools = msgs.find(
      (m) => m.role === "assistant" && Array.isArray(m.tool_calls),
    );
    const { success, data } = safeParse(AssistantWithToolsSchema, assistantWithTools);

    expect(assistantWithTools).toBeDefined();
    expect(success).toBe(true);
    expect(data?.tool_calls[0].id).toBe("c1");
    expect(data?.tool_calls[0].function.name).toBe("Bash");
    expect(JSON.parse(data?.tool_calls[0].function.arguments ?? "{}")).toEqual({
      command: "ls",
    });

    const toolMessage = msgs.find((m) => m.role === "tool");
    const { success: success2, data: data2 } = safeParse(ToolMessageSchema, toolMessage);

    expect(toolMessage).toBeDefined();
    expect(success2).toBe(true);
    expect(data2?.tool_call_id).toBe("c1");
    expect(data2?.content).toBe("a.txt");

    // The plain user + final assistant turns survive too.
    expect(msgs.some((m) => m.role === "user" && m.content === "list files")).toBe(true);
    expect(msgs.some((m) => m.role === "assistant" && m.content === "Found a.txt")).toBe(true);
  });
});

describe("image tool results over OpenAI endpoints", () => {
  const DATA = Buffer.from("img-bytes").toString("base64");
  const history: Message[] = [
    {
      role: "assistant",
      content: "",
      toolUses: [
        {
          toolUseId: "c1",
          toolName: "ReadFile",
          arguments: { file_path: "a.png" },
        },
      ],
    },
    {
      role: "user",
      content: "",
      toolResults: [
        {
          toolUseId: "c1",
          content: "[Image: a.png]",
          contentBlocks: [
            { type: "text", text: "[Image: a.png]" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: DATA },
            },
          ],
          isError: false,
        },
      ],
    },
  ];

  it("chat completions: flattens role:tool text and appends a synthetic user message with the image", () => {
    const msgs = buildChatCompletionMessages(history);
    const toolMsg = msgs.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("[Image: a.png]");
    expect(JSON.stringify(toolMsg)).not.toContain(DATA);

    const synthetic = msgs.find((m) => m.role === "user" && Array.isArray(m.content));
    expect(synthetic).toBeDefined();
    const PartsSchema = z.array(
      z.looseObject({
        type: z.string(),
        text: z.string().optional(),
        image_url: z.looseObject({ url: z.string() }).optional(),
      }),
    );
    const parts = parse(PartsSchema, synthetic?.content);
    expect(parts[0].type).toBe("text");
    expect(parts[0].text).toBe("[Rich content returned by tool call c1]");
    expect(parts[1].type).toBe("image_url");
    expect(parts[1].image_url?.url).toBe(`data:image/png;base64,${DATA}`);
  });

  it("responses API: converts rich tool output inside function_call_output", () => {
    const items = buildOpenAIInput(history);
    const fco = items.find((item) => "type" in item && item.type === "function_call_output");
    const output = fco && "output" in fco ? fco.output : null;
    expect(Array.isArray(output)).toBe(true);
    const PartsSchema = z.array(
      z.looseObject({
        type: z.string(),
        text: z.string().optional(),
        image_url: z.string().optional(),
      }),
    );
    const parts = parse(PartsSchema, output);
    expect(parts[0].type).toBe("input_text");
    expect(parts[0].text).toBe("[Image: a.png]");
    expect(parts[1].type).toBe("input_image");
    expect(parts[1].image_url).toBe(`data:image/png;base64,${DATA}`);
    expect(items).toHaveLength(2);
  });

  it("converts URL images and PDF documents for both OpenAI protocols", () => {
    const rich: Message[] = [
      {
        role: "user",
        content: "",
        toolResults: [
          {
            toolUseId: "c-rich",
            content: "image and document",
            contentBlocks: [
              {
                type: "image",
                source: { type: "url", url: "https://example.com/image.png" },
              },
              {
                type: "document",
                title: "report",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: "QUJD",
                },
              },
            ],
            isError: false,
          },
        ],
      },
    ];

    const responses = buildOpenAIInput(rich);
    const responseOutput =
      "output" in responses[0] && Array.isArray(responses[0].output) ? responses[0].output : [];
    expect(responseOutput).toEqual([
      { type: "input_text", text: "image and document" },
      {
        type: "input_image",
        image_url: "https://example.com/image.png",
        detail: "auto",
      },
      { type: "input_file", file_data: "QUJD", filename: "report.pdf" },
    ]);

    const chat = buildChatCompletionMessages(rich);
    const synthetic = chat.find(
      (message) => message.role === "user" && Array.isArray(message.content),
    );
    expect(synthetic && Array.isArray(synthetic.content) ? synthetic.content : []).toEqual([
      { type: "text", text: "[Rich content returned by tool call c-rich]" },
      {
        type: "image_url",
        image_url: { url: "https://example.com/image.png" },
      },
      { type: "file", file: { file_data: "QUJD", filename: "report.pdf" } },
    ]);
  });

  it("does not emit extra rich parts for text-only Anthropic blocks", () => {
    const textOnly: Message[] = [
      {
        role: "user",
        content: "",
        toolResults: [
          {
            toolUseId: "c2",
            content: "plain",
            contentBlocks: [{ type: "text", text: "plain" }],
            isError: false,
          },
        ],
      },
    ];
    const chat = buildChatCompletionMessages(textOnly);
    expect(chat.some((message) => message.role === "user" && Array.isArray(message.content))).toBe(
      false,
    );
    const responses = buildOpenAIInput(textOnly);
    const fco = responses.find((item) => "type" in item && item.type === "function_call_output");
    expect(fco && "output" in fco ? fco.output : null).toEqual([
      { type: "input_text", text: "plain" },
    ]);
  });

  it("converts user messages with image blocks into multimodal parts", () => {
    const userWithImage: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: DATA },
          },
        ],
      },
    ];

    const chat = buildChatCompletionMessages(userWithImage);
    expect(chat).toHaveLength(1);
    const chatParts = chat[0].content;
    expect(Array.isArray(chatParts)).toBe(true);
    expect(JSON.stringify(chatParts)).toContain(`data:image/png;base64,${DATA}`);

    const responses = buildOpenAIInput(userWithImage);
    expect(responses).toHaveLength(1);
    const respParts = "content" in responses[0] ? responses[0].content : null;
    expect(Array.isArray(respParts)).toBe(true);
    expect(JSON.stringify(respParts)).toContain("input_image");
  });
});
