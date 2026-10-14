package docs

import (
	"context"

	"github.com/hangtiancheng/yukino-code/apps/dejavu/internal/logger"
)

// SyncStats counts the outcome of one knowledge-base refresh.
type SyncStats struct {
	Indexed int `json:"indexed"`
	Skipped int `json:"skipped"`
	Removed int `json:"removed"`
	Failed  int `json:"failed"`
	Chunks  int `json:"chunks"`
}

// BuildChunks splits one document into index rows. The chunk id is stable for
// a source path and the chunk's position in that file.
func BuildChunks(source, content string) []IndexChunk {
	sourceHash := SHA256(source)
	parts := SplitMarkdown(content)
	chunks := make([]IndexChunk, 0, len(parts))
	for i, part := range parts {
		if part.Content == "" {
			continue
		}
		chunks = append(chunks, IndexChunk{
			ID:      sourceHash + ":" + itoa(i),
			Content: part.Content,
			Metadata: map[string]any{
				"_source": source,
				"title":   part.Title,
			},
		})
	}
	return chunks
}

// SyncDocs indexes changed files and removes sources that disappeared.
// A per-file failure keeps the previous version and increments Failed.
func SyncDocs(ctx context.Context, store *Context, docsDir string) (SyncStats, error) {
	scanned, err := ScanDocsDir(docsDir)
	if err != nil {
		return SyncStats{}, err
	}
	known, err := ReadSourceHashes(ctx, store.DB)
	if err != nil {
		return SyncStats{}, err
	}
	var stats SyncStats
	seen := make(map[string]struct{}, len(scanned))
	for _, doc := range scanned {
		seen[doc.Source] = struct{}{}
		if doc.Content == nil {
			stats.Failed++
			continue
		}
		hash := SHA256(*doc.Content)
		if known[doc.Source] == hash {
			stats.Skipped++
			continue
		}
		count, err := ReplaceSource(ctx, store, doc.Source, BuildChunks(doc.Source, *doc.Content), &hash)
		if err != nil {
			var conflict *LockConflictError
			if asLock(err, &conflict) {
				stats.Skipped++
				logger.Info("another instance is indexing this source, skipping", "source", doc.Source)
				continue
			}
			stats.Failed++
			logger.Warn("failed to index document", "source", doc.Source, logger.Err(err))
			continue
		}
		stats.Indexed++
		stats.Chunks += count
	}
	for source := range known {
		if _, ok := seen[source]; ok {
			continue
		}
		if err := DeleteBySource(ctx, store, source); err != nil {
			var conflict *LockConflictError
			if asLock(err, &conflict) {
				stats.Skipped++
				continue
			}
			stats.Failed++
			logger.Warn("failed to remove deleted document from index", "source", source, logger.Err(err))
			continue
		}
		stats.Removed++
	}
	logger.Info("docs sync complete", "docsDir", docsDir, "indexed", stats.Indexed, "skipped", stats.Skipped, "removed", stats.Removed, "failed", stats.Failed, "chunks", stats.Chunks)
	return stats, nil
}

func asLock(err error, target **LockConflictError) bool {
	if err == nil {
		return false
	}
	conflict, ok := err.(*LockConflictError)
	if ok {
		*target = conflict
	}
	return ok
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
