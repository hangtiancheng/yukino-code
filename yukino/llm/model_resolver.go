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

import "github.com/hangtiancheng/yukino-code/yukino/config"

var modelAliases = map[string]string{
	"haiku":  "claude-haiku-4-6",
	"sonnet": "claude-sonnet-4-6",
	"opus":   "claude-opus-4-6",
}

// ResolveModelId maps a model alias onto its concrete id (TS:
// resolveModelId); unknown names pass through unchanged.
func ResolveModelId(shortName string) string {
	if modelID, ok := modelAliases[shortName]; ok {
		return modelID
	}
	return shortName
}

// NewModelResolver returns the subagent client factory (TS spawn.ts:
// createClient(provider, systemPrompt)). An empty model inherits the base
// provider's model; systemPrompt is used verbatim for the fresh client —
// callers compute it as the definition's system_prompt override or the
// standard buildSystemPrompt for the resolved model.
func NewModelResolver(baseCfg config.ProviderConfig) func(model, systemPrompt string) (Client, error) {
	return func(model, systemPrompt string) (Client, error) {
		cfg := baseCfg
		if model != "" && model != "inherit" {
			cfg.Model = ResolveModelId(model)
		}
		return NewClient(&cfg, systemPrompt)
	}
}
