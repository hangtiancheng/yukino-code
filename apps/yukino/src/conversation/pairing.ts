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

import type { Message, ToolResultBlock } from "./index.js";

// Anthropic requires every tool_use to have a matching tool_result; a single missing
// pairing causes the entire request to be rejected. Unpaired entries can creep into
// the conversation history in several ways: the user interrupts mid-tool-execution,
// a session is restored from disk after the process exits, or concurrent writes
// interleave. Here we reconcile the pairing uniformly before sending the request, so
// individual frontends don't each have to reimplement it.

/** Used to fill in tool calls that have no result. The tool may never have started,
 *  or it may have been interrupted partway through, so the wording must not assert
 *  that it produced no side effects. */
export const INTERRUPTED_TOOL_RESULT =
  "Tool execution was interrupted. The tool may or may not have completed; verify before relying on its effects.";

/** Used for tool calls the user explicitly declined to authorize. In this case we can
 *  assert that nothing was changed, and we must state this clearly; otherwise the
 *  model will assume the modification took effect and proceed accordingly. */
export const REJECTED_TOOL_RESULT =
  "The user rejected this tool use. Nothing was changed (for file edits, the new content was NOT written).";

/**
 * Returns a copy of the messages with the pairing relationships repaired; the input
 * is not modified.
 *
 * Results must immediately follow their assistant turn, before any ordinary user
 * content. Group consecutive result messages, fill missing results at that turn
 * boundary, and drop orphan or duplicate results. The patched content is not written
 * back to the conversation history: the history should faithfully record what actually
 * happened, while the patching exists only to make this particular request valid.
 */
export function ensureToolPairing(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "assistant" && m.toolUses?.length) {
      out.push(m);
      const pending = new Set(m.toolUses.map((tu) => tu.toolUseId));
      const results: ToolResultBlock[] = [];
      const resultMessages: Message[] = [];
      while (i + 1 < messages.length) {
        const next = messages[i + 1];
        if (
          next.role !== "user" ||
          !next.toolResults?.length ||
          next.toolUses?.length
        ) {
          break;
        }
        i++;
        resultMessages.push(next);
        for (const tr of next.toolResults) {
          if (pending.delete(tr.toolUseId)) {
            results.push(tr);
          }
        }
      }
      for (const toolUseId of pending) {
        results.push({
          toolUseId,
          content: INTERRUPTED_TOOL_RESULT,
          isError: true,
        });
      }

      // A single result group also keeps Chat Completions' synthetic image user
      // message from splitting the tool results belonging to one assistant turn.
      out.push({
        ...(resultMessages[0] ?? { role: "user", content: "" }),
        toolResults: results,
      });
      for (const remaining of resultMessages.slice(1)) {
        if (remaining.content.length > 0 || remaining.thinkingBlocks?.length) {
          out.push({ ...remaining, toolResults: [] });
        }
      }
      continue;
    }

    if ((m.toolResults?.length ?? 0) > 0) {
      if (
        m.content.length === 0 &&
        !m.toolUses?.length &&
        !m.thinkingBlocks?.length
      ) {
        continue; // The message is now an empty shell; drop it to preserve role alternation
      }
      out.push({ ...m, toolResults: [] });
    } else {
      out.push(m);
    }
  }
  return out;
}
