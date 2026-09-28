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

import { ConversationManager } from "@/conversation/index.js";
import type { LLMClient } from "@/llm/client.js";

/**
 * One-shot LLM call helper. The TS LLMClient binds its system prompt at
 * construction, so single-purpose calls (grouping, plan, filter, re-location)
 * inline their instructions as the user message — the same pattern the memory
 * selector uses.
 */
export async function callOnce(
  client: LLMClient,
  prompt: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  abortSignal?.throwIfAborted();
  const conversation = new ConversationManager();
  conversation.addUserMessage(prompt);
  let text = "";
  for await (const event of client.stream(conversation, [], abortSignal)) {
    abortSignal?.throwIfAborted();
    if (event.type === "text_delta") {
      text += event.text;
    }
  }
  return text;
}
