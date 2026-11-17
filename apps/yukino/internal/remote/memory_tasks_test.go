package remote

import (
	"context"
	"testing"

	"github.com/yukino-js/yukino/yukino/internal/agent"
	"github.com/yukino-js/yukino/yukino/internal/config"
	"github.com/yukino-js/yukino/yukino/internal/conversation"
	"github.com/yukino-js/yukino/yukino/internal/llm"
	"github.com/yukino-js/yukino/yukino/internal/permissions"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

type stubMemoryClient struct{}

func (stubMemoryClient) Stream(context.Context, *conversation.Manager, []map[string]any) (<-chan llm.StreamEvent, <-chan error) {
	events := make(chan llm.StreamEvent)
	errs := make(chan error)
	close(events)
	close(errs)
	return events, errs
}

func (stubMemoryClient) SetSystemPrompt(string) {}

// TestMemoryTasksLifecycle pins the reference onLoopComplete/stopMemoryTasks
// contract: lazy creation on the first loop completion, instance reuse while
// live, dispose+null on stop with recreation on the next loop, and no
// recreation once the server is disposed.
func TestMemoryTasksLifecycle(t *testing.T) {
	wd := t.TempDir()
	s := NewServer([]config.ProviderConfig{{Name: "p", Protocol: "openai", Model: "m"}}, nil, nil, "", false, 0, nil, true)
	s.conv = conversation.NewManager()
	s.client = stubMemoryClient{}
	ag := &agent.Agent{}
	s.installMemoryTasks(ag, wd)

	if s.memoryTasks != nil {
		t.Fatal("memory tasks must be created lazily, not at install time")
	}
	ag.OnLoopComplete(s.conv)
	first := s.memoryTasks
	if first == nil {
		t.Fatal("OnLoopComplete must create the memory tasks")
	}
	ag.OnLoopComplete(s.conv)
	if s.memoryTasks != first {
		t.Fatal("OnLoopComplete must reuse the live tasks")
	}

	s.stopMemoryTasks()
	if s.memoryTasks != nil {
		t.Fatal("stopMemoryTasks must clear the reference")
	}
	ag.OnLoopComplete(s.conv)
	if s.memoryTasks == nil || s.memoryTasks == first {
		t.Fatal("OnLoopComplete must recreate fresh tasks after a stop")
	}

	s.Stop()
	if s.memoryTasks != nil {
		t.Fatal("Stop must dispose the memory tasks")
	}
	ag.OnLoopComplete(s.conv)
	if s.memoryTasks != nil {
		t.Fatal("a late OnLoopComplete must not recreate tasks after dispose")
	}
}

// TestClearConversationStopsMemoryTasks pins the reference clearConversation
// `await this.stopMemoryTasks()` step: /clear disposes the live tasks so the
// next loop completion recreates them bound to the reset conversation.
func TestClearConversationStopsMemoryTasks(t *testing.T) {
	wd := t.TempDir()
	s := NewServer([]config.ProviderConfig{{Name: "p", Protocol: "openai", Model: "m"}}, nil, nil, "", false, 0, nil, true)
	s.conv = conversation.NewManager()
	s.client = stubMemoryClient{}
	s.defaultTools = tools.CreateDefaultToolsWithWorkDir(wd)
	ag := &agent.Agent{
		Checker: permissions.NewChecker(permissions.NewPathSandbox(wd, true), permissions.NewRuleEngine(wd), permissions.ModeDefault),
	}
	s.ag = ag
	s.installMemoryTasks(ag, wd)
	ag.OnLoopComplete(s.conv)
	if s.memoryTasks == nil {
		t.Fatal("OnLoopComplete must create the memory tasks")
	}

	s.clearConversation()
	if s.memoryTasks != nil {
		t.Fatal("clearConversation must dispose the memory tasks")
	}
}
