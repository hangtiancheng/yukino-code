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

// Package extractor implements the background memory extraction subagent.
//
// Triggering: the host sets agent.Agent.OnLoopComplete to a closure that
// calls (*Extractor).Execute. The agent loop fires that callback
// fire-and-forget after each LoopComplete event. Extractor itself spawns its
// own goroutine stack via runExtraction, which means Execute returns quickly
// and the actual extraction happens in the background.
package extractor

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/hangtiancheng/yukino-code/yukino/agent"
	"github.com/hangtiancheng/yukino-code/yukino/conversation"
	"github.com/hangtiancheng/yukino-code/yukino/llm"
	"github.com/hangtiancheng/yukino-code/yukino/memory"
	"github.com/hangtiancheng/yukino-code/yukino/tools"
	"github.com/hangtiancheng/yukino-code/yukino/utils"
)

// summaryMessageWindow is how many trailing parent messages feed the
// extraction summary (TS remote/server.ts onLoopComplete: slice(-40)).
const summaryMessageWindow = 40

// Deps holds the external collaborators an Extractor needs. The host
// constructs one Deps value at startup, wraps it in an Extractor, and hooks
// the resulting Execute method onto agent.Agent.OnLoopComplete.
//
// AppendSystem is the conduit for the "Memory saved: foo.md" notice that the
// user sees after a successful extraction.
type Deps struct {
	MemoryDir     string                           // <wd>/.yukino/memory/ — project/reference (trailing sep)
	UserMemoryDir string                           // ~/.yukino/memory/ — user/feedback (trailing sep); may be "" if $HOME unresolved
	ProjectRoot   string                           // absolute project root
	Client        llm.Client                       // forked extraction agent's LLM client
	ToolRegistry  *tools.Registry                  // parent tool registry (kept for host wiring; the subagent builds its own five-tool registry)
	Protocol      string                           // "anthropic" / "openai"
	Conversation  *conversation.Manager            // parent conversation reference (summary source)
	AppendSystem  func(string)                     // optional: notify host of saved memories
	DebugLogf     func(format string, args ...any) // optional: debug logging
}

// Extractor is the background memory extractor (TS MemoryExtractor). State is
// encapsulated in struct fields; mu guards every mutable field. Each Extractor
// instance is independent — tests can construct one with mock Deps without
// touching global state.
//
// Mapping to the TS closure state: inProgress / turnsSinceLastExtraction /
// pendingContext carry over directly; pendingContext holds the stashed
// conversation summary for the trailing run.
type Extractor struct {
	deps Deps

	mu                       sync.Mutex
	inFlight                 map[*sync.WaitGroup]struct{}
	inProgress               bool
	turnsSinceLastExtraction int
	pendingContext           *string
}

// InitExtractMemories constructs a new Extractor with the given Deps.
func InitExtractMemories(deps Deps) *Extractor {
	return &Extractor{
		deps:     deps,
		inFlight: make(map[*sync.WaitGroup]struct{}),
	}
}

// Execute is the fire-and-forget entrypoint wired onto agent.Agent.OnLoopComplete.
// It builds the conversation summary from the parent conversation (TS
// remote/server.ts onLoopComplete) and runs Extract. Returns quickly; the
// actual extraction work happens on the caller goroutine. Errors are
// best-effort — the caller (agent loop) ignores the return value.
func (e *Extractor) Execute(ctx context.Context) error {
	if e == nil {
		return nil
	}
	wg := &sync.WaitGroup{}
	wg.Add(1)
	e.mu.Lock()
	e.inFlight[wg] = struct{}{}
	e.mu.Unlock()
	defer func() {
		wg.Done()
		e.mu.Lock()
		delete(e.inFlight, wg)
		e.mu.Unlock()
	}()

	_, err := e.Extract(ctx, e.conversationSummary())
	return err
}

// Extract runs one extraction pass over the given conversation summary
// (TS extractor.ts:79-85). If another pass is in flight, the summary is
// stashed and picked up by the trailing run. Returns the saved memory names.
func (e *Extractor) Extract(ctx context.Context, conversationSummary string) ([]string, error) {
	if e == nil {
		return nil, nil
	}
	e.mu.Lock()
	if e.inProgress {
		s := conversationSummary
		e.pendingContext = &s
		e.mu.Unlock()
		return nil, nil
	}
	e.mu.Unlock()
	return e.runExtraction(ctx, conversationSummary, false)
}

func (e *Extractor) runExtraction(ctx context.Context, conversationSummary string, isTrailingRun bool) (result []string, err error) {
	// Throttle: at least 1 round apart (trailing runs skip throttling).
	e.mu.Lock()
	if !isTrailingRun {
		e.turnsSinceLastExtraction++
		if e.turnsSinceLastExtraction < 1 {
			e.mu.Unlock()
			return nil, nil
		}
	}
	e.turnsSinceLastExtraction = 0
	e.inProgress = true
	e.mu.Unlock()

	defer func() {
		e.mu.Lock()
		e.inProgress = false
		pending := e.pendingContext
		e.pendingContext = nil
		e.mu.Unlock()
		if pending != nil {
			trailing, terr := e.runExtraction(ctx, *pending, true)
			if terr == nil {
				result = append(result, trailing...)
			}
		}
	}()

	return e.doExtract(ctx, conversationSummary)
}

// doExtract is the core extraction logic: child agent + five file tools in a
// fresh empty conversation carrying only the extraction prompt (TS
// extractor.ts:192-249).
func (e *Extractor) doExtract(ctx context.Context, conversationSummary string) ([]string, error) {
	startTime := time.Now()
	extractionPrompt := e.buildExtractionPrompt(conversationSummary)

	// Tool registry: the fixed five file-operation tools (ReadFile/WriteFile/
	// EditFile/Glob/Grep) — no Bash, no Agent (TS extractor.ts:197-202).
	subRegistry := memory.NewMemoryToolRegistry()

	// Scoped permission checker (TS MemoryPermissionChecker, extractor.ts:204):
	// commands denied, writes limited to .md files inside the memory
	// directories. Extraction does not get project-wide reads
	// (allowProjectReads=false).
	subChecker := memory.NewSubAgentChecker(e.deps.ProjectRoot, e.deps.UserMemoryDir, false)

	forkedConv := conversation.NewManager()
	forkedConv.AddUserMessage(extractionPrompt)

	subAgent := agent.New(e.deps.Client, subRegistry, e.deps.Protocol)
	subAgent.MaxIterations = 5
	subAgent.Checker = subChecker
	subAgent.WorkDir = e.deps.ProjectRoot

	// Drive the child agent to completion without propagating events to the
	// UI; concurrently collect streamed text as a fallback parse source when
	// the LLM issues no tool calls (i.e., emits structured text blocks
	// directly). TS extractor.ts:219-228.
	var streamedText strings.Builder
	for ev := range subAgent.Run(ctx, forkedConv) {
		if st, ok := ev.(agent.StreamText); ok {
			streamedText.WriteString(st.Text)
		}
	}

	// Fast path: LLM wrote memory files directly using WriteFile/EditFile tools.
	writtenPaths := memory.ExtractWrittenPaths(forkedConv.GetMessages())
	var memoryPaths []string
	for _, p := range writtenPaths {
		if filepath.Base(p) != memory.AutoMemEntrypointName {
			memoryPaths = append(memoryPaths, p)
		}
	}

	var saved []string
	if len(memoryPaths) > 0 {
		for _, p := range memoryPaths {
			saved = append(saved, filepath.Base(p))
		}
	} else {
		// Fallback path: LLM emitted MEMORY_NAME/... text blocks directly;
		// parse locally and persist.
		var err error
		saved, err = e.persistTextMemories(streamedText.String())
		if err != nil {
			return nil, err
		}
	}

	// Rebuild index after writing (TS extractor.ts:242-246). TS rebuildIndex
	// throws out of doExtract when the index write fails, aborting the run
	// before the "Memory saved" notice; propagate the same way.
	if len(saved) > 0 {
		if err := memory.NewManager(e.deps.ProjectRoot).RebuildIndex(); err != nil {
			return nil, err
		}
	}

	e.deps.debugf("[extractMemories] finished in %s, %d memories saved: %v",
		time.Since(startTime), len(saved), saved)

	if len(saved) > 0 && e.deps.AppendSystem != nil {
		e.deps.AppendSystem(fmt.Sprintf("Memory saved: %s", strings.Join(saved, ", ")))
	}
	return saved, nil
}

// buildExtractionPrompt assembles the prompt with the dedup manifest and the
// memory directories (TS extractor.ts:157-190).
func (e *Extractor) buildExtractionPrompt(conversationSummary string) string {
	return buildExtractionPrompt(conversationSummary, e.scanExistingMemories(), e.userMemDir(), e.projectMemDir())
}

// projectMemDir returns the project memory directory without a trailing
// separator (TS: join(workDir, ".yukino", "memory")).
func (e *Extractor) projectMemDir() string {
	if e.deps.MemoryDir != "" {
		return strings.TrimRight(e.deps.MemoryDir, string(filepath.Separator))
	}
	return filepath.Join(e.deps.ProjectRoot, ".yukino", "memory")
}

// userMemDir returns the configured user memory directory without a trailing
// separator, or "" when unset.
func (e *Extractor) userMemDir() string {
	return strings.TrimRight(e.deps.UserMemoryDir, string(filepath.Separator))
}

// conversationSummary renders the parent conversation's trailing messages as
// the extraction input (TS remote/server.ts onLoopComplete): the last 40
// messages as "[role]: text" lines where text is contentToText(m.content),
// dropping lines of 12 or fewer UTF-16 code units.
func (e *Extractor) conversationSummary() string {
	if e.deps.Conversation == nil {
		return ""
	}
	msgs := e.deps.Conversation.GetMessages()
	if len(msgs) > summaryMessageWindow {
		msgs = msgs[len(msgs)-summaryMessageWindow:]
	}
	lines := make([]string, 0, len(msgs))
	for _, m := range msgs {
		// TS contentToText(m.content): block content renders through the
		// block-aware fallback ([Image: …] placeholders included); string
		// content passes through.
		text := m.Content
		if len(m.ContentBlocks) > 0 {
			text = utils.ContentToText(m.ContentBlocks)
		}
		s := fmt.Sprintf("[%s]: %s", m.Role, text)
		// TS filter uses JS string length — UTF-16 code units, not bytes.
		if utils.UTF16Len(s) > 12 {
			lines = append(lines, s)
		}
	}
	return strings.Join(lines, "\n")
}

// Drain waits for all in-flight extractions (including any pending trailing run) to finish, with a
// soft timeout. Call from the host's shutdown path so the extraction agent isn't killed mid-write.
//
// timeoutMs of 0 returns immediately if any work is still in-flight. Negative timeoutMs is treated
// as 60000 (60s default).
func (e *Extractor) Drain(timeoutMs int) error {
	if e == nil {
		return nil
	}
	if timeoutMs < 0 {
		timeoutMs = 60000
	}

	e.mu.Lock()
	wgs := make([]*sync.WaitGroup, 0, len(e.inFlight))
	for wg := range e.inFlight {
		wgs = append(wgs, wg)
	}
	e.mu.Unlock()

	if len(wgs) == 0 {
		return nil
	}

	done := make(chan struct{})
	go func() {
		for _, wg := range wgs {
			wg.Wait()
		}
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-time.After(time.Duration(timeoutMs) * time.Millisecond):
		return nil
	}
}

func (d Deps) debugf(format string, args ...any) {
	if d.DebugLogf != nil {
		d.DebugLogf(format, args...)
	}
}
