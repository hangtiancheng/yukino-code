package remote

import (
	"context"
	"slices"
	"sync/atomic"
	"testing"

	"github.com/hangtiancheng/yukino-code/apps/yukino/agent"
	"github.com/hangtiancheng/yukino-code/apps/yukino/commands"
	"github.com/hangtiancheng/yukino-code/apps/yukino/config"
	"github.com/hangtiancheng/yukino-code/apps/yukino/conversation"
	"github.com/hangtiancheng/yukino-code/apps/yukino/llm"
	"github.com/hangtiancheng/yukino-code/apps/yukino/permissions"
	"github.com/hangtiancheng/yukino-code/apps/yukino/session"
	"github.com/hangtiancheng/yukino-code/apps/yukino/tools"
)

type stubClient struct {
	calls   atomic.Int32
	started chan []conversation.Message
	release <-chan struct{}
	observe func()
}

func (c *stubClient) SetSystemPrompt(string) {}

func (c *stubClient) Stream(ctx context.Context, conv *conversation.Manager, _ []map[string]any) (<-chan llm.StreamEvent, <-chan error) {
	c.calls.Add(1)
	if c.observe != nil {
		c.observe()
	}
	events, errs := make(chan llm.StreamEvent, 2), make(chan error)
	if c.started != nil {
		c.started <- slices.Clone(conv.GetMessages())
	}
	go func() {
		defer close(events)
		defer close(errs)
		if c.release != nil {
			select {
			case <-c.release:
			case <-ctx.Done():
				return
			}
		}
		events <- llm.TextDelta{Text: "done"}
		events <- llm.StreamEnd{StopReason: "end_turn", Usage: llm.UsageInfo{InputTokens: 7, OutputTokens: 3}}
	}()
	return events, errs
}

func newTestServer(t *testing.T, client llm.Client) *Server {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Chdir(t.TempDir())
	s := NewServer([]config.ProviderConfig{{Name: "p", Protocol: "openai", Model: "m"}}, nil, nil, "", false, 0, nil, false)
	s.client = client
	s.conv = conversation.NewManager()
	s.registry = tools.NewRegistry()
	s.sessionID = session.NewID()
	s.cmdRegistry = commands.CreateDefaultRegistry()
	s.ag = agent.New(client, s.registry, "openai")
	s.ag.Checker = permissions.NewChecker(permissions.NewPathSandbox(mustGetwd(), true), permissions.NewRuleEngine(mustGetwd()), permissions.ModeDefault)
	s.ag.SetSessionID(s.sessionID)
	s.ag.ContextWindow = 200000
	return s
}
