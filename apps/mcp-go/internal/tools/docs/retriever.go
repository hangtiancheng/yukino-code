package docs

import (
	"context"
	"database/sql"
	"encoding/json"
	"strconv"
)

// RetrievedDoc is one ranked chunk.
type RetrievedDoc struct {
	ID       string         `json:"id"`
	Content  string         `json:"content"`
	Metadata map[string]any `json:"metadata"`
	Score    float64        `json:"score"`
}

// Retrieve embeds query and returns the top limit chunks by cosine similarity.
// Scores are mapped from [-1, 1] onto [0, 1].
func Retrieve(ctx context.Context, store *Context, query string, limit int) ([]RetrievedDoc, error) {
	vector, err := store.Embedder.EmbedText(ctx, query)
	if err != nil {
		return nil, err
	}
	queryVector := NormalizeVector(vector)
	cache, err := ensureCache(store)
	if err != nil {
		return nil, err
	}
	if len(cache.IDs) == 0 || len(queryVector) != cache.Dim {
		return nil, nil
	}
	type scored struct {
		index int
		score float32
	}
	best := make([]scored, 0, limit)
	for i := range cache.IDs {
		offset := i * cache.Dim
		var dot float32
		for d := 0; d < cache.Dim; d++ {
			dot += cache.Matrix[offset+d] * queryVector[d]
		}
		if dot < -1 {
			dot = -1
		} else if dot > 1 {
			dot = 1
		}
		if len(best) == limit && dot <= best[len(best)-1].score {
			continue
		}
		at := len(best)
		for at > 0 && best[at-1].score < dot {
			at--
		}
		best = append(best, scored{})
		copy(best[at+1:], best[at:])
		best[at] = scored{index: i, score: dot}
		if len(best) > limit {
			best = best[:limit]
		}
	}
	docs := make([]RetrievedDoc, 0, len(best))
	for _, hit := range best {
		var content, rawMeta string
		err := store.DB.QueryRowContext(ctx, `SELECT content, metadata FROM chunks WHERE id = ?`, cache.IDs[hit.index]).Scan(&content, &rawMeta)
		if err == sql.ErrNoRows {
			continue
		}
		if err != nil {
			return nil, err
		}
		docs = append(docs, RetrievedDoc{
			ID:       cache.IDs[hit.index],
			Content:  content,
			Metadata: parseMetadata(rawMeta),
			Score:    float64(1+hit.score) / 2,
		})
	}
	return docs, nil
}

func ensureCache(store *Context) (*VectorCache, error) {
	version := DataVersion(store.DB)
	if store.Cache != nil && store.Cache.DataVersion == version {
		return store.Cache, nil
	}
	dimText, err := ReadMeta(store.DB, "dim")
	if err != nil {
		return nil, err
	}
	dim, _ := strconv.Atoi(dimText)
	rows, err := store.DB.Query(`SELECT id, vector FROM chunks`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	var matrix []float32
	for rows.Next() {
		var id string
		var blob []byte
		if err := rows.Scan(&id, &blob); err != nil {
			return nil, err
		}
		if dim <= 0 || len(blob) != dim*4 {
			continue
		}
		matrix = append(matrix, BlobToVector(blob, dim)...)
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	cache := &VectorCache{DataVersion: version, Dim: dim, IDs: ids, Matrix: matrix}
	store.Cache = cache
	return cache, nil
}

func parseMetadata(raw string) map[string]any {
	var parsed map[string]any
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil || parsed == nil {
		return map[string]any{}
	}
	return parsed
}
