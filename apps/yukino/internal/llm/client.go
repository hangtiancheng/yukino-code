package llm

import (
	"context"
	"fmt"

	"github.com/yukino-js/yukino/yukino/internal/config"
	"github.com/yukino-js/yukino/yukino/internal/conversation"
	"github.com/yukino-js/yukino/yukino/internal/telemetry"
)

type Client interface {
	Stream(ctx context.Context, conv *conversation.Manager, tools []map[string]any) (<-chan StreamEvent, <-chan error)
	SetSystemPrompt(prompt string)
}

type MaxTokensSetter interface {
	SetMaxOutputTokens(tokens int)
}

// ThinkingLevelControl is the runtime control of the effective logical
// thinking level.
type ThinkingLevelControl interface {
	// SetThinkingLevel applies the level and returns the effective one, which
	// may be clamped by the provider.
	SetThinkingLevel(level string) string
	GetThinkingLevel() string
	GetSupportedThinkingLevels() []string
}

type OutputBudget struct {
	MaxOutputTokens int
	// Planning allowance for the provider-native reasoning effort.
	ThinkingTokens int
}

type OutputBudgetProvider interface {
	GetOutputBudget() OutputBudget
}

func NewClient(cfg *config.ProviderConfig, systemPrompt string) (Client, error) {
	var client Client
	var err error
	switch cfg.Protocol {
	case "anthropic":
		client, err = newAnthropicClient(cfg, systemPrompt)
	case "openai":
		client, err = newOpenAIClient(cfg, systemPrompt)
	case "openai-compat":
		client, err = newOpenAICompatClient(cfg, systemPrompt)
	default:
		return nil, fmt.Errorf("unknown protocol: %s", cfg.Protocol)
	}
	if err != nil {
		return nil, err
	}
	return telemetry.RegisterLlmClient(client, telemetry.LlmMetadata{Model: cfg.Model, Protocol: cfg.Protocol}), nil
}

type maxOutputKey struct{}

func WithMaxOutputTokens(ctx context.Context, tokens int) context.Context {
	return context.WithValue(ctx, maxOutputKey{}, tokens)
}
func maxOutputTokens(ctx context.Context, fallback int) int {
	if tokens, ok := ctx.Value(maxOutputKey{}).(int); ok && tokens > 0 {
		return tokens
	}
	return fallback
}

type answerReserveKey struct{}

// WithAnswerReserveTokens reserves answer tokens out of the max-output budget
// when the provider computes a thinking budget (StreamOptions
// answerReserveTokens in the reference).
func WithAnswerReserveTokens(ctx context.Context, tokens int) context.Context {
	return context.WithValue(ctx, answerReserveKey{}, tokens)
}
func answerReserveTokens(ctx context.Context) int {
	if tokens, ok := ctx.Value(answerReserveKey{}).(int); ok && tokens > 0 {
		return tokens
	}
	return 0
}

type maxRetriesKey struct{}

// WithMaxRetries overrides the provider SDK's per-request retry count
// (StreamOptions.maxRetries in the reference). Goal-summarizing turns use 0 to
// avoid retry delays.
func WithMaxRetries(ctx context.Context, retries int) context.Context {
	return context.WithValue(ctx, maxRetriesKey{}, retries)
}
func maxRetries(ctx context.Context) (int, bool) {
	retries, ok := ctx.Value(maxRetriesKey{}).(int)
	return retries, ok
}
