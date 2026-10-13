package docs

import (
	"context"
	"database/sql"
	"encoding/json"
	"math"
	"time"
)

const maxContentLength = 8192

// IndexChunk is one chunk ready to embed and store.
type IndexChunk struct {
	ID       string
	Content  string
	Metadata map[string]any
}

// ReplaceSource replaces every chunk for source and records hash. A nil hash
// deletes the source record. Embedding happens before the write transaction.
func ReplaceSource(ctx context.Context, store *Context, source string, chunks []IndexChunk, hash *string) (int, error) {
	vectors := make([][]float64, len(chunks))
	if len(chunks) > 0 {
		texts := make([]string, len(chunks))
		for i, chunk := range chunks {
			texts[i] = chunk.Content
		}
		embedded, err := store.Embedder.EmbedTexts(ctx, texts)
		if err != nil {
			return 0, err
		}
		vectors = embedded
	}
	if len(vectors) != len(chunks) || !validVectors(vectors) {
		return 0, errString("embedding provider returned invalid or missing vectors")
	}
	createdAt := time.Now().UTC().Format(time.RFC3339Nano)
	err := transact(ctx, store.DB, source, func(conn *sql.Conn) error {
		if _, err := conn.ExecContext(ctx, `DELETE FROM chunks WHERE source = ?`, source); err != nil {
			return err
		}
		for i, chunk := range chunks {
			meta, err := json.Marshal(chunk.Metadata)
			if err != nil {
				return err
			}
			content := chunk.Content
			if len(content) > maxContentLength {
				content = content[:maxContentLength]
			}
			_, err = conn.ExecContext(ctx, `
INSERT INTO chunks (id, source, content, metadata, created_at, vector)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  source = excluded.source, content = excluded.content,
  metadata = excluded.metadata, created_at = excluded.created_at,
  vector = excluded.vector`,
				chunk.ID, source, content, string(meta), createdAt, VectorToBlob(NormalizeVector(vectors[i])))
			if err != nil {
				return err
			}
		}
		if hash == nil {
			_, err := conn.ExecContext(ctx, `DELETE FROM sources WHERE source = ?`, source)
			return err
		}
		_, err := conn.ExecContext(ctx, `
INSERT INTO sources (source, hash) VALUES (?, ?)
ON CONFLICT(source) DO UPDATE SET hash = excluded.hash`, source, *hash)
		return err
	})
	if err != nil {
		return 0, err
	}
	store.Cache = nil
	return len(chunks), nil
}

// DeleteBySource removes a source and its chunks.
func DeleteBySource(ctx context.Context, store *Context, source string) error {
	_, err := ReplaceSource(ctx, store, source, nil, nil)
	return err
}

// ReadSourceHashes returns the stored content hash of every source.
func ReadSourceHashes(ctx context.Context, db *sql.DB) (map[string]string, error) {
	rows, err := db.QueryContext(ctx, `SELECT source, hash FROM sources`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	hashes := make(map[string]string)
	for rows.Next() {
		var source, hash string
		if err := rows.Scan(&source, &hash); err != nil {
			return nil, err
		}
		hashes[source] = hash
	}
	return hashes, rows.Err()
}

func transact(ctx context.Context, db *sql.DB, label string, work func(*sql.Conn) error) error {
	conn, err := db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, `BEGIN IMMEDIATE`); err != nil {
		if IsBusyError(err) {
			return &LockConflictError{Source: label}
		}
		return err
	}
	if err := work(conn); err != nil {
		_, _ = conn.ExecContext(ctx, `ROLLBACK`)
		if IsBusyError(err) {
			return &LockConflictError{Source: label}
		}
		return err
	}
	if _, err := conn.ExecContext(ctx, `COMMIT`); err != nil {
		_, _ = conn.ExecContext(ctx, `ROLLBACK`)
		if IsBusyError(err) {
			return &LockConflictError{Source: label}
		}
		return err
	}
	return nil
}

func validVectors(vectors [][]float64) bool {
	for _, vector := range vectors {
		if len(vector) == 0 {
			return false
		}
		for _, value := range vector {
			if math.IsNaN(value) || math.IsInf(value, 0) {
				return false
			}
		}
	}
	return true
}

type stringError string

func (e stringError) Error() string { return string(e) }

func errString(msg string) error { return stringError(msg) }
