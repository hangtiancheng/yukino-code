package docs

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/config"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/logger"
	_ "modernc.org/sqlite"
)

const schemaVersion = "1"

const schemaSQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS sources (
  source TEXT PRIMARY KEY,
  hash   TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS chunks (
  id         TEXT PRIMARY KEY,
  source     TEXT NOT NULL,
  content    TEXT NOT NULL,
  metadata   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  vector     BLOB NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS chunks_source_idx ON chunks(source);
`

// VectorCache is the in-memory matrix used for cosine retrieval.
type VectorCache struct {
	DataVersion int64
	Dim         int
	IDs         []string
	Matrix      []float32
}

// Context is the open index plus the embedding client.
type Context struct {
	DB       *sql.DB
	Embedder Embedder
	DBPath   string
	Cache    *VectorCache
	cacheMu  sync.Mutex
}

func (store *Context) invalidateCache() {
	store.cacheMu.Lock()
	store.Cache = nil
	store.cacheMu.Unlock()
}

// LockConflictError means another process holds the write lock.
type LockConflictError struct {
	Source string
}

func (e *LockConflictError) Error() string {
	return fmt.Sprintf("another process is writing %q to the index", e.Source)
}

// IsBusyError reports a SQLite busy or locked failure.
func IsBusyError(err error) bool {
	if err == nil {
		return false
	}
	var coder interface{ Code() int }
	if errors.As(err, &coder) && coder.Code() == 5 {
		return true
	}
	text := err.Error()
	return strings.Contains(text, "SQLITE_BUSY") || strings.Contains(text, "database is locked")
}

// OpenStore opens the SQLite index, creating parent directories when needed.
func OpenStore(index config.IndexConfig) (*sql.DB, error) {
	dsn := index.DBPath
	if index.DBPath != ":memory:" {
		if err := os.MkdirAll(filepath.Dir(index.DBPath), 0o755); err != nil {
			return nil, err
		}
		dsn = "file:" + index.DBPath + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)"
	} else {
		dsn = "file::memory:?cache=shared&_pragma=busy_timeout(5000)"
	}
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schemaSQL); err != nil {
		_ = db.Close()
		return nil, err
	}
	return db, nil
}

// CloseStore closes the index, ignoring a nil or already-closed database.
func CloseStore(db *sql.DB) {
	if db == nil {
		return
	}
	_ = db.Close()
}

// EnsureSchema probes the embedding dimension and rebuilds the index when it
// does not match the stored schema.
func EnsureSchema(ctx context.Context, store *Context) error {
	vector, err := store.Embedder.EmbedText(ctx, "dimension probe")
	if err != nil {
		return err
	}
	if len(vector) == 0 {
		return errors.New("embedding provider returned an empty vector")
	}
	dim := len(vector)
	storedVersion, _ := ReadMeta(store.DB, "schema_version")
	storedDim, _ := ReadMeta(store.DB, "dim")
	if storedVersion == schemaVersion && storedDim == fmt.Sprint(dim) {
		return nil
	}
	if storedVersion == schemaVersion && storedDim != "" {
		logger.Warn("index dimension mismatch, wiping and rebuilding the index", "storedDim", storedDim, "dim", dim)
	}
	if _, err := store.DB.Exec(`DELETE FROM chunks`); err != nil {
		return err
	}
	if _, err := store.DB.Exec(`DELETE FROM sources`); err != nil {
		return err
	}
	if err := WriteMeta(store.DB, "schema_version", schemaVersion); err != nil {
		return err
	}
	if err := WriteMeta(store.DB, "dim", fmt.Sprint(dim)); err != nil {
		return err
	}
	store.invalidateCache()
	logger.Info("vector index created", "dim", dim, "path", store.DBPath)
	return nil
}

// ReadMeta returns a meta value, or an empty string when the key is absent.
func ReadMeta(db *sql.DB, key string) (string, error) {
	var value string
	err := db.QueryRow(`SELECT value FROM meta WHERE key = ?`, key).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return value, err
}

// WriteMeta upserts one meta row.
func WriteMeta(db *sql.DB, key, value string) error {
	_, err := db.Exec(`INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value)
	return err
}

// DataVersion reads SQLite's data_version pragma.
func DataVersion(db *sql.DB) int64 {
	var version int64
	if err := db.QueryRow(`PRAGMA data_version`).Scan(&version); err != nil {
		return 0
	}
	return version
}
