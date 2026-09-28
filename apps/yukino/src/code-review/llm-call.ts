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
