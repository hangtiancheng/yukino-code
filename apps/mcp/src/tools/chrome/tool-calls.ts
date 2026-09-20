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

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { SocketConnectionError } from "./mcp-socket-client.js";
import type { YukinoForChromeContext, SocketClient } from "./types.js";
import { toLoggerDetail } from "./types.js";

export const handleToolCall = async (
  context: YukinoForChromeContext,
  socketClient: SocketClient,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> => {
  try {
    const isConnected = await socketClient.ensureConnected();

    context.logger.silly(
      `[${context.serverName}] Server is connected: ${isConnected}. Received tool call: ${name} with args: ${JSON.stringify(args)}.`,
    );

    if (isConnected) {
      return await handleToolCallConnected(context, socketClient, name, args);
    }

    return handleToolCallDisconnected(context);
  } catch (error) {
    context.logger.info(
      `[${context.serverName}] Error calling tool:`,
      toLoggerDetail(error),
    );

    if (error instanceof SocketConnectionError) {
      return handleToolCallDisconnected(context);
    }

    return {
      content: [
        {
          type: "text",
          text: `Error calling tool, please try again. : ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

async function handleToolCallConnected(
  context: YukinoForChromeContext,
  socketClient: SocketClient,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const response = await socketClient.callTool(name, args);

  context.logger.silly(
    `[${context.serverName}] Received result from socket: ${JSON.stringify(response)}`,
  );

  if (response === null || response === undefined) {
    return {
      content: [{ type: "text", text: "Tool execution completed" }],
    };
  }

  // Response will have either result or error field
  const { result, error } = response as {
    result?: { content: unknown[] | string };
    error?: { content: unknown[] | string };
  };

  // Determine which field has the content and whether it's an error
  const contentData = error || result;
  const isError = !!error;

  if (!contentData) {
    return {
      content: [{ type: "text", text: "Tool execution completed" }],
    };
  }

  const { content } = contentData;

  if (content && Array.isArray(content)) {
    if (isError) {
      return {
        content: content.map((item: unknown) => {
          if (typeof item === "object" && item !== null && "type" in item) {
            return item;
          }

          return { type: "text", text: String(item) };
        }),
        isError: true,
      } as CallToolResult;
    }

    const convertedContent = content.map((item: unknown) => {
      if (
        typeof item === "object" &&
        item !== null &&
        "type" in item &&
        "source" in item
      ) {
        const typedItem = item;
        if (
          typedItem.type === "image" &&
          typeof typedItem.source === "object" &&
          typedItem.source !== null &&
          "data" in typedItem.source
        ) {
          return {
            type: "image",
            data: typedItem.source.data,
            mimeType:
              "media_type" in typedItem.source
                ? typedItem.source.media_type || "image/png"
                : "image/png",
          };
        }
      }

      if (typeof item === "object" && item !== null && "type" in item) {
        return item;
      }

      return { type: "text", text: String(item) };
    });

    return {
      content: convertedContent,
      isError,
    } as CallToolResult;
  }

  // Handle string content
  if (typeof content === "string") {
    return {
      content: [{ type: "text", text: content }],
      isError,
    } as CallToolResult;
  }

  // Fallback for unexpected result format
  context.logger.warn(
    `[${context.serverName}] Unexpected result format from socket: ${JSON.stringify(response)}`,
  );

  return {
    content: [{ type: "text", text: JSON.stringify(response) }],
    isError,
  };
}

function handleToolCallDisconnected(
  context: YukinoForChromeContext,
): CallToolResult {
  const text = context.onToolCallDisconnected();
  return {
    content: [{ type: "text", text }],
  };
}
