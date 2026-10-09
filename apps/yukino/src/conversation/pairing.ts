import type { Message, ToolResultBlock } from "./index.js";

// Both Anthropic and OpenAI reject the entire request when a tool use lacks its
// matching tool result. Unpaired entries can creep into the conversation history in
// several ways: the user interrupts mid-tool-execution, a session is restored from
// disk after the process exits, or concurrent writes interleave. Here we reconcile
// the pairing uniformly before sending the request, so individual frontends don't
// each have to reimplement it.

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
