package agent

import (
	"context"
	"time"

	"github.com/yukino-js/yukino/yukino/internal/permissions"
	"github.com/yukino-js/yukino/yukino/internal/session"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

type AgentEvent interface{ agentEvent() }

type StreamText struct{ Text string }
type ThinkingText struct{ Text string }
type ThinkingComplete struct{ Thinking, Signature string }
type SteeringDelivered struct{ Text, InputID string }
type ToolUseEvent struct {
	ToolID   string
	ToolName string
	Args     map[string]any
}
type ToolResultEvent struct {
	ToolID        string
	ToolName      string
	Output        string
	IsError       bool
	Elapsed       time.Duration
	ContentBlocks []map[string]any
	McpApp        *tools.McpAppResult
}
type TurnComplete struct{ Turn int }
type LoopComplete struct {
	TotalTurns int
	PlanReady  bool
	StopReason string
}
type UsageEvent struct{ InputTokens, OutputTokens, CacheReadTokens, CacheCreationTokens int }
type ErrorEvent struct{ Message string }
type CompactEvent struct {
	Message  string
	Boundary *session.CompactBoundary
}
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

type PermissionReply struct {
	Response PermissionResponse
}

type PermissionRequestEvent struct {
	Context    context.Context
	AgentName  string
	Cwd        string
	ToolID     string
	Args       map[string]any
	Decision   permissions.Decision
	ToolName   string
	Desc       string
	ResponseCh chan<- PermissionReply
}

func (StreamText) agentEvent() {}

func (ThinkingText) agentEvent()      {}
func (ThinkingComplete) agentEvent()  {}
func (SteeringDelivered) agentEvent() {}

func (ToolUseEvent) agentEvent()    {}
func (ToolResultEvent) agentEvent() {}

func (TurnComplete) agentEvent() {}

func (LoopComplete) agentEvent() {}
func (UsageEvent) agentEvent()   {}
func (ErrorEvent) agentEvent()   {}
func (CompactEvent) agentEvent() {}

func (RetryEvent) agentEvent()             {}
func (PermissionRequestEvent) agentEvent() {}

type AskUserQuestionEvent struct {
	Questions  []map[string]any
	ResponseCh chan map[string]string
}

func (AskUserQuestionEvent) agentEvent() {}
