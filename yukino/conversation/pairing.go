// Copyright (c) 2026 hangtiancheng
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

package conversation

// Anthropic requires every tool_use to have a paired tool_result; a single
// missing pair causes the entire request to be rejected. Unpaired entries can
// reach the conversation history in several ways: the user interrupting mid
// tool execution, a session being restored from disk after a process exit, or
// interleaved concurrent writes. These placeholder messages fill the gaps; on
// seeing them the model should understand that the tool produced no output.
const (
	// InterruptedToolResult fills in a tool call that has no result. The tool
	// may never have started, or it may have been interrupted halfway through,
	// so the wording must not assert that it had no side effects.
	InterruptedToolResult = "Tool execution was interrupted. The tool may or may not have completed; verify before relying on its effects."
	// RejectedToolResult fills in a tool call the user explicitly refused to
	// authorize. In this case we can assert that nothing changed, and that must
	// be stated clearly; otherwise the model will assume the change took effect
	// and proceed accordingly.
	RejectedToolResult = "The user rejected this tool use. Nothing was changed (for file edits, the new content was NOT written)."
)

// EnsureToolPairing returns a copy of the messages with the pairing
// relationships repaired; the input is not modified.
//
// Results must immediately follow their assistant turn, before any ordinary
// user content. Group consecutive result messages, fill missing results at
// that turn boundary, and drop orphan or duplicate results. The patched
// content is not written back to the conversation history: the history should
// faithfully record what actually happened, while the patching exists only to
// make this particular request valid.
func EnsureToolPairing(messages []Message) []Message {
	out := make([]Message, 0, len(messages))
	for i := 0; i < len(messages); i++ {
		m := messages[i]
		if m.Role == "assistant" && len(m.ToolUses) > 0 {
			out = append(out, m)
			// Pending tool_use ids of this turn, in issuance order and
			// deduplicated like a Set.
			var pending []string
			pendingSet := make(map[string]struct{}, len(m.ToolUses))
			for _, tu := range m.ToolUses {
				if _, ok := pendingSet[tu.ToolUseID]; ok {
					continue
				}
				pendingSet[tu.ToolUseID] = struct{}{}
				pending = append(pending, tu.ToolUseID)
			}
			// Consume the run of adjacent result messages belonging to this
			// turn; results that are duplicates or belong to another turn are
			// dropped.
			var results []ToolResultBlock
			var resultMessages []Message
			for i+1 < len(messages) {
				next := messages[i+1]
				if next.Role != "user" || len(next.ToolResults) == 0 || len(next.ToolUses) > 0 {
					break
				}
				i++
				resultMessages = append(resultMessages, next)
				for _, tr := range next.ToolResults {
					if _, ok := pendingSet[tr.ToolUseID]; ok {
						delete(pendingSet, tr.ToolUseID)
						results = append(results, tr)
					}
				}
			}
			// Fill in the calls of this turn that never got a result, at the
			// turn boundary rather than wherever a late result may sit.
			for _, id := range pending {
				if _, ok := pendingSet[id]; !ok {
					continue // resolved by a real result
				}
				results = append(results, ToolResultBlock{
					ToolUseID: id,
					Content:   InterruptedToolResult,
					IsError:   true,
				})
			}

			// A single result group also keeps Chat Completions' synthetic
			// image user message from splitting the tool results belonging to
			// one assistant turn.
			merged := Message{Role: "user"}
			if len(resultMessages) > 0 {
				merged = resultMessages[0]
			}
			merged.ToolResults = results
			out = append(out, merged)
			for j := 1; j < len(resultMessages); j++ {
				remaining := resultMessages[j]
				// TS measures content.length, which for a block array is the
				// block count — ContentBlocks count as content too.
				if remaining.Content != "" || len(remaining.ContentBlocks) > 0 || len(remaining.ThinkingBlocks) > 0 {
					remaining.ToolResults = nil
					out = append(out, remaining)
				}
			}
			continue
		}

		if len(m.ToolResults) > 0 {
			// A result that is not adjacent to its call cannot be paired; drop
			// it and keep only the message's own content.
			if m.Content == "" && len(m.ContentBlocks) == 0 && len(m.ToolUses) == 0 && len(m.ThinkingBlocks) == 0 {
				continue // the message is now an empty shell; drop it to preserve role alternation
			}
			m.ToolResults = nil
			out = append(out, m)
		} else {
			out = append(out, m)
		}
	}
	return out
}
