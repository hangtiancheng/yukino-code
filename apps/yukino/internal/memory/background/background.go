package background

import (
	"context"
	"reflect"
	"strings"
	"sync"

	"github.com/yukino-js/yukino/yukino/internal/conversation"
	"github.com/yukino-js/yukino/yukino/internal/llm"
	"github.com/yukino-js/yukino/yukino/internal/memory"
	"github.com/yukino-js/yukino/yukino/internal/memory/consolidation"
	"github.com/yukino-js/yukino/yukino/internal/memory/extractor"
	"github.com/yukino-js/yukino/yukino/internal/utils"
)

type Callbacks struct {
	OnSaved      func(names []string)
	AppendSystem func(message string)
}

type Tasks struct {
	extractor    *extractor.Extractor
	consolidator *consolidation.Consolidator
	callbacks    Callbacks

	mu         sync.Mutex
	cursor     *conversation.Message
	pending    []conversation.Message
	completion chan struct{}
	disposed   bool
}

func New(client llm.Client, cwd string, callbacks Callbacks) *Tasks {
	tasks := &Tasks{callbacks: callbacks}
	tasks.extractor = extractor.New(client, cwd)
	tasks.consolidator = consolidation.New(client, cwd, consolidation.Options{
		AppendSystem: func(message string) {
			tasks.mu.Lock()
			disposed := tasks.disposed
			tasks.mu.Unlock()
			if !disposed && callbacks.AppendSystem != nil {
				callbacks.AppendSystem(message)
			}
		},
	})
	return tasks
}

// Run queues the conversation's latest messages and starts the drain when it
// is not already running, then checks the consolidation gates.
func (t *Tasks) Run(conversationManager *conversation.Manager) {
	t.mu.Lock()
	if t.disposed {
		t.mu.Unlock()
		return
	}
	messages := conversationManager.GetMessages()
	t.pending = append([]conversation.Message(nil), messages...)
	start := t.completion == nil
	if start {
		t.completion = make(chan struct{})
	}
	done := t.completion
	t.mu.Unlock()

	if start {
		go t.startDrain(done)
	}
	t.consolidator.MaybeRun(context.Background())
}

func (t *Tasks) startDrain(done chan struct{}) {
	defer func() {
		close(done)
		t.mu.Lock()
		if t.completion == done {
			t.completion = nil
		}
		hasPending := len(t.pending) > 0 && !t.disposed
		t.mu.Unlock()
		if hasPending {
			t.mu.Lock()
			next := make(chan struct{})
			t.completion = next
			t.mu.Unlock()
			go t.startDrain(next)
		}
	}()
	t.drain()
}

func (t *Tasks) drain() {
	for {
		t.mu.Lock()
		if t.disposed || len(t.pending) == 0 {
			t.pending = nil
			t.mu.Unlock()
			return
		}
		messages := t.pending
		t.pending = nil
		cursor := t.cursor
		t.mu.Unlock()

		start := 0
		if cursor != nil {
			for i := len(messages) - 1; i >= 0; i-- {
				if reflect.DeepEqual(messages[i], *cursor) {
					start = i + 1
					break
				}
			}
		}
		if len(messages)-start < memory.MinExtractMessages {
			continue
		}
		windowStart := start
		if len(messages)-memory.ExtractSummaryWindow > windowStart {
			windowStart = len(messages) - memory.ExtractSummaryWindow
		}
		var lines []string
		for _, message := range messages[windowStart:] {
			line := "[" + message.Role + "]: " + utils.ContentToText(contentOf(message))
			if len(line) > memory.MinSummaryLineChars {
				lines = append(lines, line)
			}
		}
		summary := strings.Join(lines, "\n")
		saved := t.extractor.Extract(context.Background(), summary)
		t.mu.Lock()
		if t.disposed {
			t.mu.Unlock()
			return
		}
		last := messages[len(messages)-1]
		t.cursor = &last
		t.mu.Unlock()
		if len(saved) > 0 && t.callbacks.OnSaved != nil {
			t.callbacks.OnSaved(saved)
		}
	}
}

func contentOf(message conversation.Message) any {
	if len(message.ContentBlocks) > 0 {
		return message.ContentBlocks
	}
	return message.Content
}

// Dispose stops in-flight work and awaits its settlement.
func (t *Tasks) Dispose() {
	t.mu.Lock()
	t.disposed = true
	t.pending = nil
	completion := t.completion
	t.mu.Unlock()
	t.extractor.Dispose()
	t.consolidator.Dispose()
	if completion != nil {
		<-completion
	}
}
