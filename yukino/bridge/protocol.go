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

// Package bridge hosts the transport-agnostic core of the Yukino agent
// bridges: one private agent session per user, the JSON-RPC 2.0 protocol
// vocabulary, and the fan-out of agent progress to attached client
// connections.
//
// Two transports sit on top of it, both speaking JSON-RPC 2.0:
//
//   - internal/ws    — the browser websocket (one connection per device;
//     prompts arrive through the chat pipeline, not through the socket)
//   - internal/stdio — a newline-delimited stdin/stdout server for spawning
//     the agent as a child process (prompts arrive as session/prompt)
//
// Downstream agent progress travels as JSON-RPC notifications; upstream
// control (permission answers, question answers, cancel, ping) travels as
// requests and is answered with a result or a protocol error. Permission and
// question prompts are deliberately notifications carrying their own id plus
// an explicit respond request — not server-to-client requests — so a
// reconnecting client can be re-sent the prompts it still owes an answer to.
package bridge

// Server-to-client notification methods. The params payload of each is the
// data object the pre-JSON-RPC protocol carried under the same name.
const (
	// Session lifecycle and state.
	MethodSessionConnected      = "session/connected"
	MethodSessionReady          = "session/ready"
	MethodSessionCommands       = "session/commands"
	MethodSessionContextCleared = "session/context_cleared"
	MethodSessionCommandDone    = "session/command_done"

	// Agent run progress.
	MethodAgentRunStart         = "agent/run_start"
	MethodAgentStreamText       = "agent/stream_text"
	MethodAgentStreamEnd        = "agent/stream_end"
	MethodAgentThinkingText     = "agent/thinking_text"
	MethodAgentThinkingComplete = "agent/thinking_complete"
	MethodAgentToolUse          = "agent/tool_use"
	MethodAgentToolResult       = "agent/tool_result"
	MethodAgentTurnComplete     = "agent/turn_complete"
	MethodAgentLoopComplete     = "agent/loop_complete"
	MethodAgentUsage            = "agent/usage"
	MethodAgentSystem           = "agent/system"
	MethodAgentError            = "agent/error"
	MethodAgentCompact          = "agent/compact"
	MethodAgentRetry            = "agent/retry"

	// Prompts the run blocks on, answered by the respond requests below.
	MethodPermissionRequest = "permission/request"
	MethodQuestionAsk       = "question/ask"
)

// Client-to-server request methods.
const (
	MethodPermissionRespond = "permission/respond"
	MethodQuestionRespond   = "question/respond"
	MethodSessionCancel     = "session/cancel"
	MethodPing              = "ping"
	// MethodSessionPrompt is only exposed by the stdio transport: in the
	// websocket deployment prompts travel the chat pipeline (so they are
	// persisted and echoed like any other message) and never reach the socket.
	MethodSessionPrompt = "session/prompt"
)

// Conn is one attached client connection. WriteMessage delivers a single
// encoded JSON-RPC message; it is called from several goroutines (the session
// worker, the attach path, hook callbacks) and implementations must serialize
// writes and preserve message boundaries — one websocket text frame or one
// newline-terminated line per call.
type Conn interface {
	WriteMessage(data []byte) error
}

// ChatSink writes finalized agent text back into the chat transcript, which
// is what makes replies survive a reload and show up in session previews.
type ChatSink interface {
	// SaveAssistantText stores one finalized text block as a chat message from
	// the assistant to userID, tagged with the conversation it belongs to, and
	// returns the new message uuid. An empty return means persistence failed
	// and the block exists only on screen.
	SaveAssistantText(userID, sessionID, text string) string
}

// CommandInfo describes one slash command for the composer's command menu.
type CommandInfo struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

// permissionRespondParams are the params of permission/respond.
type permissionRespondParams struct {
	ID       string `json:"id"`
	Response string `json:"response"` // allow / deny / allowAlways
}

// questionRespondParams are the params of question/respond.
type questionRespondParams struct {
	ID      string            `json:"id"`
	Answers map[string]string `json:"answers"`
}

// PromptParams are the params of session/prompt (stdio transport only).
type PromptParams struct {
	Content string `json:"content"`
}
