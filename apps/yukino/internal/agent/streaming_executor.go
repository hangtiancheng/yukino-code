package agent

import (
	"context"
	"sync"

	"github.com/yukino-js/yukino/yukino/internal/telemetry"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

type toolBatch struct {
	concurrent bool
	calls      []toolCallEntry
}

type toolCallEntry struct {
	tc    toolCallInfo
	index int
}

type toolCallInfo struct {
	toolID     string
	toolName   string
	arguments  map[string]any
	parseError string
}

type StreamingExecutor struct {
	registry  *tools.Registry
	eventCh   chan AgentEvent
	telemetry *telemetry.AgentTelemetry

	mu      sync.Mutex
	calls   []toolCallInfo
	results []toolExecResult
}

func NewStreamingExecutor(registry *tools.Registry, eventCh chan AgentEvent, agentTelemetry *telemetry.AgentTelemetry) *StreamingExecutor {
	return &StreamingExecutor{
		registry:  registry,
		eventCh:   eventCh,
		telemetry: agentTelemetry,
	}
}

func (se *StreamingExecutor) Submit(tc toolCallInfo) {
	se.mu.Lock()
	se.calls = append(se.calls, tc)
	se.mu.Unlock()
}

// ExecuteAll mirrors the reference executeTools/executeBatch split: each
// concurrency batch first runs the loop-side preparation (abort check,
// filter, routing, hooks, permissions) sequentially for every call, and only
// then executes the approved calls — concurrently for parallel batches, one
// at a time otherwise. Results are emitted and finalized in completion
// order while the returned slice retains call order for persistence.
func (se *StreamingExecutor) ExecuteAll(ctx context.Context, agent *Agent) []toolExecResult {
	se.mu.Lock()
	calls := append([]toolCallInfo(nil), se.calls...)
	se.mu.Unlock()

	results := make([]toolExecResult, len(calls))

	var entries []toolCallEntry
	for i, c := range calls {
		entries = append(entries, toolCallEntry{tc: c, index: i})
	}

	batches := partitionToolCalls(entries, se.registry)

	for _, batch := range batches {
		if batch.concurrent && len(batch.calls) > 1 {
			type preparedEntry struct {
				entry toolCallEntry
				prep  *toolPreparation
			}
			var ready []preparedEntry
			for _, entry := range batch.calls {
				prep, immediate := se.prepare(ctx, agent, entry.tc)
				if immediate != nil {
					se.emitResult(*immediate)
					results[entry.index] = *immediate
					continue
				}
				ready = append(ready, preparedEntry{entry: entry, prep: prep})
			}
			type indexedResult struct {
				index  int
				entry  toolCallEntry
				prep   *toolPreparation
				result toolExecResult
			}
			done := make(chan indexedResult, len(ready))
			var wg sync.WaitGroup
			for _, pe := range ready {
				wg.Add(1)
				go func(pe preparedEntry) {
					defer wg.Done()
					r := agent.executePreparedCall(ctx, pe.entry.tc, pe.prep, se.telemetry)
					done <- indexedResult{index: pe.entry.index, entry: pe.entry, prep: pe.prep, result: r}
				}(pe)
			}
			go func() {
				wg.Wait()
				close(done)
			}()
			for ir := range done {
				agent.finalizeToolResult(ctx, ir.entry.tc, ir.prep, ir.result)
				se.emitResult(ir.result)
				results[ir.index] = ir.result
			}
		} else {
			for _, entry := range batch.calls {
				prep, immediate := se.prepare(ctx, agent, entry.tc)
				if immediate != nil {
					se.emitResult(*immediate)
					results[entry.index] = *immediate
					continue
				}
				r := agent.executePreparedCall(ctx, entry.tc, prep, se.telemetry)
				agent.finalizeToolResult(ctx, entry.tc, prep, r)
				se.emitResult(r)
				results[entry.index] = r
			}
		}
	}

	se.results = results
	return results
}

// prepare runs the loop-side pipeline for one call. A nil preparation with a
// nil result means the call goes to the executor untouched (parse errors are
// the executor's to report, like the reference).
func (se *StreamingExecutor) prepare(ctx context.Context, agent *Agent, tc toolCallInfo) (*toolPreparation, *toolExecResult) {
	if tc.parseError != "" {
		return nil, nil
	}
	return agent.prepareToolCall(ctx, se.eventCh, tc)
}

func (se *StreamingExecutor) emitResult(r toolExecResult) {
	se.eventCh <- ToolResultEvent{ToolID: r.toolID, ToolName: r.toolName, Output: r.output, IsError: r.isError, Elapsed: r.elapsed, ContentBlocks: r.contentBlocks, McpApp: r.mcpApp}
}

func partitionToolCalls(entries []toolCallEntry, registry *tools.Registry) []toolBatch {
	var batches []toolBatch
	for _, entry := range entries {
		tool := registry.Get(entry.tc.toolName)
		safe := tool != nil && tools.IsConcurrencySafe(tool, entry.tc.arguments)

		if safe && len(batches) > 0 && batches[len(batches)-1].concurrent {
			batches[len(batches)-1].calls = append(batches[len(batches)-1].calls, entry)
		} else {
			batches = append(batches, toolBatch{
				concurrent: safe,
				calls:      []toolCallEntry{entry},
			})
		}
	}
	return batches
}

func (se *StreamingExecutor) HasPending() bool {
	se.mu.Lock()
	defer se.mu.Unlock()
	return len(se.calls) > 0
}

func (se *StreamingExecutor) Reset() {
	se.mu.Lock()
	defer se.mu.Unlock()
	se.calls = nil
	se.results = nil
}
