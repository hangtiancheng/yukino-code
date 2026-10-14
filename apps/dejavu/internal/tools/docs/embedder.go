package docs

import (
	"context"
	"fmt"
	"sort"
	"time"

	"github.com/openai/openai-go"
	"github.com/openai/openai-go/option"

	"github.com/hangtiancheng/yukino-code/apps/dejavu/internal/config"
)

const embedBatchSize = 10

// Embedder turns text into embedding vectors through an OpenAI-compatible endpoint.
type Embedder struct {
	client openai.Client
	model  string
}

// NewEmbedder builds a client for the resolved embedding configuration.
func NewEmbedder(cfg config.EmbeddingConfig) Embedder {
	return Embedder{
		client: openai.NewClient(
			option.WithAPIKey(cfg.APIKey),
			option.WithBaseURL(cfg.BaseURL),
			option.WithMaxRetries(1),
			option.WithRequestTimeout(20*time.Second),
		),
		model: cfg.Model,
	}
}

// EmbedText embeds one string.
func (e Embedder) EmbedText(ctx context.Context, text string) ([]float64, error) {
	vectors, err := e.EmbedTexts(ctx, []string{text})
	if err != nil {
		return nil, err
	}
	if len(vectors) != 1 {
		return nil, fmt.Errorf("embedding provider returned %d vectors for one input", len(vectors))
	}
	return vectors[0], nil
}

// EmbedTexts embeds texts in batches of embedBatchSize, preserving input order.
func (e Embedder) EmbedTexts(ctx context.Context, texts []string) ([][]float64, error) {
	out := make([][]float64, 0, len(texts))
	for start := 0; start < len(texts); start += embedBatchSize {
		end := start + embedBatchSize
		if end > len(texts) {
			end = len(texts)
		}
		batch, err := e.embedBatch(ctx, texts[start:end])
		if err != nil {
			return nil, err
		}
		out = append(out, batch...)
	}
	return out, nil
}

func (e Embedder) embedBatch(ctx context.Context, texts []string) ([][]float64, error) {
	resp, err := e.client.Embeddings.New(ctx, openai.EmbeddingNewParams{
		Model: e.model,
		Input: openai.EmbeddingNewParamsInputUnion{OfArrayOfStrings: texts},
	})
	if err != nil {
		return nil, err
	}
	ordered := append([]openai.Embedding(nil), resp.Data...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].Index < ordered[j].Index })
	vectors := make([][]float64, len(ordered))
	for i, item := range ordered {
		vectors[i] = item.Embedding
	}
	return vectors, nil
}
