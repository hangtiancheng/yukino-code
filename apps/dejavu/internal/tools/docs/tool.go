package docs

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/hangtiancheng/yukino-code/apps/dejavu/internal/config"
	"github.com/hangtiancheng/yukino-code/apps/dejavu/internal/logger"
	"github.com/hangtiancheng/yukino-code/apps/dejavu/internal/tools"
)

const (
	initTimeout   = 15 * time.Second
	degradedRetry = 30 * time.Second
)

// SearchInput is the docs_tool argument schema.
type SearchInput struct {
	Query string `json:"query" jsonschema:"Natural-language question or keywords to search the knowledge base with."`
	TopK  int    `json:"top_k,omitempty" jsonschema:"Number of most relevant chunks to return (1-10, default 3)."`
}

// SyncInput is the empty docs_sync argument schema.
type SyncInput struct{}

type engineState struct {
	ready  bool
	reason string
	store  *Context
}

var (
	stateMu      sync.Mutex
	settled      *engineState
	loading      chan struct{}
	lastDegraded time.Time
	syncMu       sync.Mutex
	syncCurrent  *syncCall
)

type syncCall struct {
	done  chan struct{}
	stats SyncStats
	err   error
}

// Module returns the docs tool module.
func Module() tools.ToolModule {
	return tools.ToolModule{
		Name: "docs",
		Register: func(server *mcp.Server) {
			docsDir := config.Load().DocsDir
			tools.AddTool(server, &mcp.Tool{
				Name:        tools.DocsSync,
				Title:       "Sync Docs",
				Description: "Refresh the RAG knowledge base from the configured local docs directory. Waits for initial/in-flight indexing, adds/updates changed files and removes deleted files. Call after editing documents or when docs_tool reports indexing in progress. Per-file failures preserve the previous version and are reported in stats.",
				Annotations: &mcp.ToolAnnotations{
					ReadOnlyHint:    false,
					DestructiveHint: boolPtr(true),
					IdempotentHint:  true,
					OpenWorldHint:   boolPtr(true),
				},
			}, handleSync)
			tools.AddTool(server, &mcp.Tool{
				Name:  tools.DocsTool,
				Title: "Search Docs",
				Description: "Semantic search (embedding-based RAG) over the local Yukino knowledge base " +
					"built from Markdown/text documents in " + docsDir + ". " +
					"Use it to look up project- or team-specific knowledge, internal guides and notes. " +
					"Returns the most relevant document chunks with their source file, section title " +
					"and similarity score.",
				Annotations: &mcp.ToolAnnotations{
					ReadOnlyHint:    true,
					DestructiveHint: boolPtr(false),
					IdempotentHint:  true,
					OpenWorldHint:   boolPtr(false),
				},
			}, handleSearch)
		},
		Init: func(ctx context.Context) error {
			_, err := getState(ctx)
			return err
		},
		Shutdown: func(context.Context) error {
			stateMu.Lock()
			current := settled
			settled = nil
			stateMu.Unlock()
			if current != nil && current.store != nil {
				CloseStore(current.store.DB)
			}
			return nil
		},
	}
}

func handleSync(ctx context.Context, _ *mcp.CallToolRequest, _ SyncInput) (*mcp.CallToolResult, any, error) {
	state, err := getState(ctx)
	if err != nil {
		return failText("docs is unavailable: " + err.Error()), nil, nil
	}
	if !state.ready {
		return failText("docs is unavailable: " + state.reason), nil, nil
	}
	stats, err := runSync(ctx, state.store)
	if err != nil {
		return failText("docs sync failed: " + err.Error()), nil, nil
	}
	res := textResult(mustJSON(stats), stats)
	if stats.Failed > 0 {
		res.IsError = true
	}
	return res, nil, nil
}

func handleSearch(ctx context.Context, _ *mcp.CallToolRequest, in SearchInput) (*mcp.CallToolResult, any, error) {
	if in.Query == "" {
		return failText("query is required"), nil, nil
	}
	topK := in.TopK
	if topK == 0 {
		topK = 3
	}
	if topK < 1 || topK > 10 {
		return failText("top_k must be between 1 and 10"), nil, nil
	}
	state, err := getState(ctx)
	if err != nil {
		return failText("docs is unavailable: " + err.Error()), nil, nil
	}
	if !state.ready {
		return failText("docs is unavailable: " + state.reason), nil, nil
	}
	found, err := Retrieve(ctx, state.store, in.Query, topK)
	if err != nil {
		logger.Warn("docs query failed", logger.Err(err))
		if state.store.DB != nil {
			if pingErr := state.store.DB.PingContext(ctx); pingErr != nil {
				degrade(fmt.Sprintf("vector index connection lost: %s", err.Error()), state.store.DB)
			}
		}
		return failText("docs failed: " + err.Error()), nil, nil
	}
	if len(found) == 0 {
		if indexing() {
			return textResult("Knowledge base indexing is still in progress. Call docs_sync to wait for it, then retry the search.", nil), nil, nil
		}
		return textResult("No matching documents in the knowledge base.", nil), nil, nil
	}
	return textResult(formatResults(found), map[string]any{
		"documents": found,
		"indexing":  indexing(),
	}), nil, nil
}

func getState(ctx context.Context) (*engineState, error) {
	for {
		stateMu.Lock()
		if settled != nil && !settled.ready && time.Since(lastDegraded) >= degradedRetry {
			settled = nil
		}
		if settled != nil {
			current := settled
			stateMu.Unlock()
			return current, nil
		}
		if loading != nil {
			wait := loading
			stateMu.Unlock()
			select {
			case <-wait:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
			continue
		}
		wait := make(chan struct{})
		loading = wait
		stateMu.Unlock()

		next := initEngine(ctx)
		stateMu.Lock()
		settled = next
		if !next.ready {
			lastDegraded = time.Now()
		}
		loading = nil
		close(wait)
		stateMu.Unlock()
		return next, nil
	}
}

func initEngine(ctx context.Context) *engineState {
	cfg := config.Load()
	if !cfg.Embedding.OK {
		reason := "embedding provider is not configured (" + cfg.Embedding.Reason + ")"
		logger.Warn("docs degraded", "reason", reason)
		return &engineState{reason: reason}
	}
	db, err := OpenStore(cfg.Index)
	if err != nil {
		reason := fmt.Sprintf("cannot open the vector index at %s: %s", cfg.Index.DBPath, err.Error())
		logger.Warn("docs degraded: index unreachable", logger.Err(err))
		return &engineState{reason: reason}
	}
	store := &Context{DB: db, Embedder: NewEmbedder(cfg.Embedding.Config), DBPath: cfg.Index.DBPath}
	initCtx, cancel := context.WithTimeout(ctx, initTimeout)
	defer cancel()
	if err := EnsureSchema(initCtx, store); err != nil {
		CloseStore(db)
		reason := fmt.Sprintf("failed to initialize the vector index (check the embedding endpoint/API key and that %s is writable): %s", cfg.Index.DBPath, err.Error())
		logger.Warn("docs degraded: index initialization failed", logger.Err(err))
		return &engineState{reason: reason}
	}
	syncMu.Lock()
	call := &syncCall{done: make(chan struct{})}
	syncCurrent = call
	syncMu.Unlock()
	go func() {
		if _, err := performSync(context.Background(), store, call); err != nil {
			logger.Warn("background docs sync failed", logger.Err(err))
		}
	}()
	logger.Info("docs ready (docs sync continues in the background)")
	return &engineState{ready: true, store: store}
}

func runSync(ctx context.Context, store *Context) (SyncStats, error) {
	syncMu.Lock()
	if syncCurrent != nil {
		call := syncCurrent
		syncMu.Unlock()
		select {
		case <-call.done:
		case <-ctx.Done():
			return SyncStats{}, ctx.Err()
		}
		return call.stats, call.err
	}
	call := &syncCall{done: make(chan struct{})}
	syncCurrent = call
	syncMu.Unlock()
	return performSync(ctx, store, call)
}

func performSync(ctx context.Context, store *Context, call *syncCall) (SyncStats, error) {
	stats, err := SyncDocs(ctx, store, config.Load().DocsDir)
	syncMu.Lock()
	call.stats, call.err = stats, err
	syncCurrent = nil
	close(call.done)
	syncMu.Unlock()
	return stats, err
}

func indexing() bool {
	syncMu.Lock()
	defer syncMu.Unlock()
	return syncCurrent != nil
}

func degrade(reason string, db *sql.DB) {
	stateMu.Lock()
	settled = &engineState{reason: reason}
	lastDegraded = time.Now()
	stateMu.Unlock()
	CloseStore(db)
}

func formatResults(docs []RetrievedDoc) string {
	var buf []byte
	for i, doc := range docs {
		if i > 0 {
			buf = append(buf, "\n\n---\n\n"...)
		}
		title, _ := doc.Metadata["title"].(string)
		if title == "" {
			title = "(untitled)"
		}
		source, _ := doc.Metadata["_source"].(string)
		if source == "" {
			source = "(unknown)"
		}
		buf = append(buf, fmt.Sprintf("[%d] source: %s | title: %s | score: %.3f\n%s", i+1, source, title, doc.Score, doc.Content)...)
	}
	return string(buf)
}

func failText(msg string) *mcp.CallToolResult {
	return &mcp.CallToolResult{
		Content: []mcp.Content{&mcp.TextContent{Text: msg}},
		IsError: true,
	}
}

func textResult(text string, structured any) *mcp.CallToolResult {
	res := &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: text}}}
	if structured != nil {
		res.StructuredContent = structured
	}
	return res
}

func mustJSON(stats SyncStats) string {
	raw, err := json.Marshal(stats)
	if err != nil {
		return fmt.Sprintf(`{"indexed":%d,"skipped":%d,"removed":%d,"failed":%d,"chunks":%d}`, stats.Indexed, stats.Skipped, stats.Removed, stats.Failed, stats.Chunks)
	}
	return string(raw)
}

func boolPtr(v bool) *bool { return &v }
