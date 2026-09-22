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

package llm

import (
	"context"
	"fmt"

	"github.com/hangtiancheng/yukino-code/yukino/config"
	"github.com/hangtiancheng/yukino-code/yukino/conversation"
	"github.com/hangtiancheng/yukino-code/yukino/logger"
)

// log mirrors the TS module-scoped child logger
// (createChildLogger({module:"llm"})).
var log = logger.CreateChildLogger("llm")

type Client interface {
	Stream(ctx context.Context, conv *conversation.Manager, tools []map[string]any) (<-chan StreamEvent, <-chan error)
	SetSystemPrompt(prompt string)
	// Protocol returns the provider protocol of the client ("anthropic",
	// "openai" or "openai-compat"). TS exposes it as the readonly
	// `client.protocol` field; telemetry's metadataFor fallback reads it for
	// unregistered clients.
	Protocol() string
	// GetThinkingLevel returns the effective logical reasoning level.
	GetThinkingLevel() config.ThinkingLevel
	// SetThinkingLevel clamps the requested level to the provider's
	// capabilities and applies it, returning the effective level.
	SetThinkingLevel(level config.ThinkingLevel) config.ThinkingLevel
	// GetSupportedThinkingLevels lists the levels available for this provider.
	GetSupportedThinkingLevels() []config.ThinkingLevel
}

type MaxTokensSetter interface {
	SetMaxOutputTokens(tokens int)
}

// clientRegistrar mirrors the registerLlmClient call that TS's createClient
// makes around every constructed client. Go's import graph runs telemetry →
// llm (telemetry consumes llm types), so llm cannot import telemetry
// directly; the telemetry package installs this hook at init. When nil
// (telemetry not linked), clients stay unregistered and telemetry's
// metadataFor falls back to the client's Protocol(), exactly like the TS
// fallback for unregistered clients.
var clientRegistrar func(client Client, model, protocol string)

// SetClientRegistrar installs the telemetry registration hook. Called from
// the telemetry package's init; application code never needs this.
func SetClientRegistrar(fn func(client Client, model, protocol string)) {
	clientRegistrar = fn
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
		return nil, fmt.Errorf("Unknown protocol: %s", cfg.Protocol)
	}
	if err != nil {
		return nil, err
	}
	// TS: createClient wraps every client in registerLlmClient with the
	// provider's model and protocol.
	if clientRegistrar != nil {
		clientRegistrar(client, cfg.Model, cfg.Protocol)
	}
	return client, nil
}
