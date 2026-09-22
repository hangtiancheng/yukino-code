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

package config

import "testing"

// TestGetContextWindow_ConfigWins verifies the configured value always wins
// when positive (TS: getContextWindow).
func TestGetContextWindow_ConfigWins(t *testing.T) {
	p := &ProviderConfig{Model: "claude-sonnet-4-6", ContextWindow: 12345}
	if got := p.GetContextWindow(); got != 12345 {
		t.Fatalf("config value should win: got %d, want 12345", got)
	}
}

// TestGetContextWindow_Default pins the TS DEFAULT_CONTEXT_WINDOW behaviour:
// an unset or non-positive context_window falls back to 1M for every model —
// TS never infers windows from model names or provider metadata, and the Go
// port must not either.
func TestGetContextWindow_Default(t *testing.T) {
	models := []string{
		"claude-sonnet-4-6",
		"claude-sonnet-4-6-1m",
		"gpt-4o",
		"gpt-4.1",
		"gpt-3.5-turbo",
		"o3-mini",
		"some-unknown-model",
		"",
	}
	for _, model := range models {
		p := &ProviderConfig{Model: model}
		if got := p.GetContextWindow(); got != DefaultContextWindow {
			t.Errorf("GetContextWindow(model=%q) = %d, want %d", model, got, DefaultContextWindow)
		}
	}
	// Non-positive values are treated as unset (TS: safe-integer && > 0 check).
	p := &ProviderConfig{Model: "claude-sonnet-4-6", ContextWindow: -1}
	if got := p.GetContextWindow(); got != DefaultContextWindow {
		t.Errorf("negative config value must fall back to the default, got %d", got)
	}
}
