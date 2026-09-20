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

import type { Message } from "@/conversation/index.js";

/** Only completed writes count as saved memories; assistant prose is not execution evidence. */
export function extractWrittenPaths(messages: Message[]): string[] {
  const successful = new Set(
    messages.flatMap((message) =>
      (message.toolResults ?? [])
        .filter((result) => !result.isError)
        .map((result) => result.toolUseId),
    ),
  );
  const paths = new Set<string>();
  for (const message of messages) {
    for (const tool of message.toolUses ?? []) {
      if (
        (tool.toolName === "WriteFile" || tool.toolName === "EditFile") &&
        successful.has(tool.toolUseId) &&
        typeof tool.arguments.file_path === "string"
      ) {
        paths.add(tool.arguments.file_path);
      }
    }
  }
  return [...paths];
}
