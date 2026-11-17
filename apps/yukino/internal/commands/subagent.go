package commands

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/yukino-js/yukino/yukino/internal/agent"
	"github.com/yukino-js/yukino/yukino/internal/conversation"
	"github.com/yukino-js/yukino/yukino/internal/history"
	"github.com/yukino-js/yukino/yukino/internal/permissions"
	"github.com/yukino-js/yukino/yukino/internal/session"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

func RunSubagentCommand(ctx context.Context, name, prompt, input string, registry *tools.Registry, checker *permissions.Checker, conv *conversation.Manager, cwd, sessionID string, inputEntry *history.InputEntry) <-chan agent.AgentEvent {
	events := make(chan agent.AgentEvent, 32)
	go func() {
		defer close(events)
		if ctx.Err() != nil {
			return
		}
		tool := registry.Get("Agent")
		if tool == nil {
			events <- agent.ErrorEvent{Message: SubagentCommandUnavailable}
			return
		}
		if inputEntry == nil {
			entry, err := history.RecordInput(history.InputOptions{Cwd: cwd, SessionID: &sessionID, Source: "sdk", Text: input})
			if err != nil {
				events <- agent.ErrorEvent{Message: err.Error()}
				return
			}
			inputEntry = &entry
		}
		recorded, err := session.SaveUserMessage(cwd, sessionID, *inputEntry, session.Message{Content: input})
		if err != nil {
			events <- agent.ErrorEvent{Message: err.Error()}
			return
		}
		conv.AppendMessages([]conversation.Message{recorded.ToConversation()})
		id := uuid.NewString()
		args := map[string]any{"kind": "subagent", "subagent_type": name, "fork": name == "plan", "description": input, "prompt": prompt, "run_in_background": false}
		events <- agent.ToolUseEvent{ToolID: id, ToolName: "Agent", Args: args}
		runtime := tools.ExecutionContext{WorkDir: cwd, SessionID: sessionID, ToolCallID: id, RequestPermission: func(requestCtx context.Context, request tools.PermissionRequest) int {
			response := make(chan agent.PermissionReply, 1)
			select {
			case events <- agent.PermissionRequestEvent{Context: requestCtx, AgentName: request.AgentName, Cwd: request.Cwd, ToolName: request.ToolName, ToolID: request.ToolCallID, Args: request.Args, Desc: request.Desc, Decision: permissions.Decision{RememberPatterns: request.RememberPatterns}, ResponseCh: response}:
			case <-requestCtx.Done():
				return int(agent.PermDeny)
			}
			select {
			case reply := <-response:
				return int(reply.Response)
			case <-requestCtx.Done():
				return int(agent.PermDeny)
			}
		}}
		if checker != nil {
			runtime.Plan = &tools.PlanContext{Owner: checker, IsPlanMode: func() bool { return checker.Mode() == permissions.ModePlan }, EnterPlanMode: func() { checker.EnterPlanMode() }, IsSubagent: checker.IsSubagent(), IsTeammate: checker.Teammate}
		}
		execution := tools.WithExecutionContext(ctx, runtime)
		start := time.Now()
		var result tools.ToolResult
		if name == "plan" {
			result = tools.RunPlanAgent(registry, execution, prompt)
		} else {
			result = tool.Execute(execution, args)
		}
		session.SaveMessage(cwd, sessionID, session.Message{Role: "assistant", Content: result.Output, Timestamp: time.Now().Unix()})
		conv.AddAssistantFull(result.Output, nil, nil)
		events <- agent.ToolResultEvent{ToolID: id, ToolName: "Agent", Output: result.Output, IsError: result.IsError, Elapsed: time.Since(start), ContentBlocks: result.ContentBlocks, McpApp: result.McpApp}
		events <- agent.StreamText{Text: result.Output}
		events <- agent.TurnComplete{Turn: 1}
		stopReason := "end_turn"
		if ctx.Err() != nil {
			stopReason = "interrupted"
		} else if result.IsError {
			stopReason = "error"
		}
		events <- agent.LoopComplete{TotalTurns: 1, PlanReady: name == "plan" && !result.IsError && ctx.Err() == nil, StopReason: stopReason}
	}()
	return events
}
