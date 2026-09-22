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

package agent

import "time"

type AgentEvent interface{ agentEvent() }

type StreamText struct{ Text string }
type ThinkingText struct{ Text string }

// ThinkingComplete carries a finalized thinking block (full text + signature),
// mirroring the TS thinking_complete event. ThinkingText streams deltas; this
// fires once when the block is complete.
type ThinkingComplete struct {
	Thinking  string
	Signature string
}

type ToolUseEvent struct {
	ToolID   string
	ToolName string
	Args     map[string]any
}
type ToolResultEvent struct {
	ToolID   string
	ToolName string
	Output   string
	IsError  bool
	Elapsed  time.Duration
	// ContentBlocks carries structured tool-result blocks (TS: the
	// tool_result event's optional contentBlocks). Populated only when the
	// tool returned rich blocks (e.g. ToolSearch tool_reference).
	ContentBlocks []map[string]any
}
type TurnComplete struct{ Turn int }

// LoopComplete signals the agent finished. StopReason mirrors the TS
// loop_complete stopReason ("end_turn", "interrupted", ...).
type LoopComplete struct {
	TotalTurns int
	StopReason string
}

// UsageEvent carries the full UsageInfo for the turn, including the cache
// fields the provider reported (TS forwards the stream_end usage object as-is).
type UsageEvent struct {
	InputTokens         int
	OutputTokens        int
	CacheReadTokens     int
	CacheCreationTokens int
}
type ErrorEvent struct{ Message string }
type CompactEvent struct{ Message string }
type RetryEvent struct {
	Reason string
	Wait   time.Duration
}

type PermissionResponse int

const (
	PermAllow PermissionResponse = iota
	PermDeny
	PermAllowAlways
)

type PermissionRequestEvent struct {
	ToolName string
	Desc     string
	// Args carries the raw tool arguments (TS: the permission_request event's
	// args field) so the host can render the full call context.
	Args       map[string]any
	ResponseCh chan<- PermissionResponse
}

func (StreamText) agentEvent() {}

func (ThinkingText) agentEvent() {}

func (ThinkingComplete) agentEvent() {}

func (ToolUseEvent) agentEvent()    {}
func (ToolResultEvent) agentEvent() {}

func (TurnComplete) agentEvent() {}

func (LoopComplete) agentEvent() {}
func (UsageEvent) agentEvent()   {}
func (ErrorEvent) agentEvent()   {}
func (CompactEvent) agentEvent() {}

func (RetryEvent) agentEvent()             {}
func (PermissionRequestEvent) agentEvent() {}
