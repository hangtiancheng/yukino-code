package docs

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/config"
)

func TestSyncUnicodeFailureRecoveryDeletionAndConcurrentCache(t *testing.T) {
	var fail atomic.Bool
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if fail.Load() {
			http.Error(w, "bad embedding", http.StatusBadRequest)
			return
		}
		var input struct {
			Input []string `json:"input"`
		}
		if err := json.NewDecoder(req.Body).Decode(&input); err != nil {
			t.Error(err)
			return
		}
		data := make([]any, len(input.Input))
		for i := range data {
			data[i] = map[string]any{"object": "embedding", "index": i, "embedding": []float64{0.1, 0.2, 0.3}}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"object": "list", "model": "test", "data": data, "usage": map[string]any{"prompt_tokens": 1, "total_tokens": 1}})
	}))
	defer endpoint.Close()
	dir := t.TempDir()
	dbPath := filepath.Join(t.TempDir(), "index.sqlite")
	t.Setenv("YUKINO_DOCS_DIR", dir)
	db, err := OpenStore(config.IndexConfig{DBPath: dbPath})
	if err != nil {
		t.Fatal(err)
	}
	defer CloseStore(db)
	store := &Context{DB: db, DBPath: dbPath, Embedder: NewEmbedder(config.EmbeddingConfig{BaseURL: endpoint.URL, APIKey: "test", Model: "test"})}
	ctx := context.Background()
	if err := EnsureSchema(ctx, store); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "中文.md")
	if err := os.WriteFile(path, []byte(strings.Repeat("中", 1000)), 0600); err != nil {
		t.Fatal(err)
	}
	stats, err := runSync(ctx, store)
	if err != nil || stats.Indexed != 1 || stats.Chunks != 1 {
		t.Fatalf("initial sync: %+v %v", stats, err)
	}
	found, err := Retrieve(ctx, store, "query", 3)
	if err != nil || len(found) != 1 || len([]rune(found[0].Content)) != 1000 {
		t.Fatalf("retrieval: %+v %v", found, err)
	}
	if err := os.WriteFile(path, []byte("# Changed\nnew document"), 0600); err != nil {
		t.Fatal(err)
	}
	fail.Store(true)
	stats, err = runSync(ctx, store)
	if err != nil || stats.Failed != 1 {
		t.Fatalf("failure not reported: %+v %v", stats, err)
	}
	fail.Store(false)
	found, err = Retrieve(ctx, store, "query", 3)
	if err != nil || len(found) != 1 || !strings.HasPrefix(found[0].Content, "中") {
		t.Fatalf("failed update destroyed old source: %+v %v", found, err)
	}
	var readers sync.WaitGroup
	for i := 0; i < 8; i++ {
		readers.Go(func() {
			for j := 0; j < 10; j++ {
				if _, err := Retrieve(ctx, store, "query", 3); err != nil {
					t.Error(err)
				}
			}
		})
	}
	stats, err = runSync(ctx, store)
	readers.Wait()
	if err != nil || stats.Indexed != 1 {
		t.Fatalf("retry: %+v %v", stats, err)
	}
	found, err = Retrieve(ctx, store, "query", 3)
	if err != nil || len(found) != 1 || found[0].Metadata["title"] != "Changed" {
		t.Fatalf("cache did not refresh: %+v %v", found, err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	stats, err = runSync(ctx, store)
	if err != nil || stats.Removed != 1 {
		t.Fatalf("deletion: %+v %v", stats, err)
	}
	found, err = Retrieve(ctx, store, "query", 3)
	if err != nil || len(found) != 0 {
		t.Fatalf("deleted source still retrieved: %+v %v", found, err)
	}
}

func TestScannerFollowsConfiguredRootButSkipsSymlinkEntries(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "file.MD"), []byte("content"), 0600); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(t.TempDir(), "docs")
	if err := os.Symlink(dir, root); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if err := os.Symlink(filepath.Join(dir, "file.MD"), filepath.Join(dir, "duplicate.md")); err != nil {
		t.Fatal(err)
	}
	docs, err := ScanDocsDir(root)
	if err != nil || len(docs) != 1 || docs[0].Source != "file.MD" {
		t.Fatalf("symlink root: %+v %v", docs, err)
	}
}
