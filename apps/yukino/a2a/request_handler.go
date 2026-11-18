package a2a

import (
	"context"
	"iter"

	a2alib "github.com/a2aproject/a2a-go/a2a"
	"github.com/a2aproject/a2a-go/a2asrv"
)

// YukinoRequestHandler decorates an a2asrv.RequestHandler, defaulting
// historyLength like the reference override of DefaultRequestHandler.
type YukinoRequestHandler struct {
	Inner a2asrv.RequestHandler
}

var _ a2asrv.RequestHandler = (*YukinoRequestHandler)(nil)

func (h *YukinoRequestHandler) SendMessage(ctx context.Context, req *a2alib.SendMessageRequest) (a2alib.SendMessageResult, error) {
	if req != nil {
		cfg := a2alib.SendMessageConfig{}
		if req.Config != nil {
			cfg = *req.Config
		}
		if cfg.HistoryLength == nil {
			historyLength := DefaultHistoryLength
			cfg.HistoryLength = &historyLength
		}
		patched := *req
		patched.Config = &cfg
		req = &patched
	}
	return h.Inner.SendMessage(ctx, req)
}

func (h *YukinoRequestHandler) GetTask(ctx context.Context, req *a2alib.GetTaskRequest) (*a2alib.Task, error) {
	if req != nil && req.HistoryLength == nil {
		patched := *req
		historyLength := DefaultHistoryLength
		patched.HistoryLength = &historyLength
		req = &patched
	}
	return h.Inner.GetTask(ctx, req)
}

func (h *YukinoRequestHandler) ListTasks(ctx context.Context, req *a2alib.ListTasksRequest) (*a2alib.ListTasksResponse, error) {
	// The library models this historyLength as a plain int, so an explicit 0
	// is indistinguishable from an unset field and receives the default.
	if req != nil && req.HistoryLength == 0 {
		patched := *req
		patched.HistoryLength = DefaultHistoryLength
		req = &patched
	}
	return h.Inner.ListTasks(ctx, req)
}

func (h *YukinoRequestHandler) CancelTask(ctx context.Context, req *a2alib.CancelTaskRequest) (*a2alib.Task, error) {
	return h.Inner.CancelTask(ctx, req)
}

func (h *YukinoRequestHandler) SubscribeToTask(ctx context.Context, req *a2alib.SubscribeToTaskRequest) iter.Seq2[a2alib.Event, error] {
	return h.Inner.SubscribeToTask(ctx, req)
}

func (h *YukinoRequestHandler) SendStreamingMessage(ctx context.Context, req *a2alib.SendMessageRequest) iter.Seq2[a2alib.Event, error] {
	if req != nil {
		cfg := a2alib.SendMessageConfig{}
		if req.Config != nil {
			cfg = *req.Config
		}
		if cfg.HistoryLength == nil {
			historyLength := DefaultHistoryLength
			cfg.HistoryLength = &historyLength
		}
		patched := *req
		patched.Config = &cfg
		req = &patched
	}
	return h.Inner.SendStreamingMessage(ctx, req)
}

func (h *YukinoRequestHandler) GetTaskPushConfig(ctx context.Context, req *a2alib.GetTaskPushConfigRequest) (*a2alib.TaskPushConfig, error) {
	return h.Inner.GetTaskPushConfig(ctx, req)
}

func (h *YukinoRequestHandler) ListTaskPushConfigs(ctx context.Context, req *a2alib.ListTaskPushConfigRequest) ([]*a2alib.TaskPushConfig, error) {
	return h.Inner.ListTaskPushConfigs(ctx, req)
}

func (h *YukinoRequestHandler) CreateTaskPushConfig(ctx context.Context, req *a2alib.CreateTaskPushConfigRequest) (*a2alib.TaskPushConfig, error) {
	return h.Inner.CreateTaskPushConfig(ctx, req)
}

func (h *YukinoRequestHandler) DeleteTaskPushConfig(ctx context.Context, req *a2alib.DeleteTaskPushConfigRequest) error {
	return h.Inner.DeleteTaskPushConfig(ctx, req)
}

func (h *YukinoRequestHandler) GetExtendedAgentCard(ctx context.Context, req *a2alib.GetExtendedAgentCardRequest) (*a2alib.AgentCard, error) {
	return h.Inner.GetExtendedAgentCard(ctx, req)
}
