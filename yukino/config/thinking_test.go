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

import (
	"reflect"
	"testing"
)

func thinkingTestProvider(protocol string) *ProviderConfig {
	return &ProviderConfig{
		Name:     "p",
		Protocol: protocol,
		BaseURL:  "#",
		Model:    "m",
	}
}

func strPtr(s string) *string { return &s }

func boolPtr(b bool) *bool { return &b }

func TestGetThinkingLevelDefaultsHigh(t *testing.T) {
	for _, protocol := range []string{"anthropic", "openai", "openai-compat"} {
		p := thinkingTestProvider(protocol)
		if got := GetThinkingLevel(p); got != ThinkingHigh {
			t.Errorf("%s: default level = %q, want high", protocol, got)
		}
	}
}

func TestGetThinkingLevelPassthrough(t *testing.T) {
	p := thinkingTestProvider("anthropic")
	p.Thinking = ThinkingMax
	if got := GetThinkingLevel(p); got != ThinkingMax {
		t.Errorf("level = %q, want max", got)
	}
	p.Thinking = ThinkingOff
	if got := GetThinkingLevel(p); got != ThinkingOff {
		t.Errorf("level = %q, want off", got)
	}
	// An invalid stored value falls back to the default.
	p.Thinking = "bogus"
	if got := GetThinkingLevel(p); got != ThinkingHigh {
		t.Errorf("invalid level = %q, want high fallback", got)
	}
}

func TestThinkingBudgets(t *testing.T) {
	cases := map[ThinkingLevel]int{
		ThinkingMinimal: 1024,
		ThinkingLow:     2048,
		ThinkingMedium:  8192,
		ThinkingHigh:    16384,
		ThinkingXHigh:   32768,
		ThinkingMax:     65536,
		ThinkingOff:     0,
	}
	for level, want := range cases {
		if got := ThinkingBudgetForLevel(level); got != want {
			t.Errorf("budget(%q) = %d, want %d", level, got, want)
		}
	}
}

func TestToReasoningEffort(t *testing.T) {
	if got := ToReasoningEffort(ThinkingOff, nil); got == nil || *got != "none" {
		t.Errorf("off must map to \"none\", got %v", got)
	}
	if got := ToReasoningEffort(ThinkingLow, nil); got == nil || *got != "low" {
		t.Errorf("low must map to \"low\", got %v", got)
	}
	if got := ToReasoningEffort(ThinkingMax, nil); got == nil || *got != "max" {
		t.Errorf("max must map to \"max\", got %v", got)
	}

	// reasoning:false disables everything.
	p := thinkingTestProvider("openai")
	p.Reasoning = boolPtr(false)
	if got := ToReasoningEffort(ThinkingHigh, p); got != nil {
		t.Errorf("reasoning:false must yield nil, got %v", *got)
	}

	// thinking_level_map overrides win; null disables the level.
	p = thinkingTestProvider("openai")
	p.ThinkingLevelMap = map[string]*string{
		"low":   strPtr("medium"),
		"xhigh": nil,
	}
	if got := ToReasoningEffort(ThinkingLow, p); got == nil || *got != "medium" {
		t.Errorf("map override failed: %v", got)
	}
	if got := ToReasoningEffort(ThinkingXHigh, p); got != nil {
		t.Errorf("null map entry must disable the level, got %v", *got)
	}

	// Anthropic adaptive narrows minimal→low and xhigh→high.
	p = thinkingTestProvider("anthropic")
	p.ThinkingMode = "adaptive"
	if got := ToReasoningEffort(ThinkingMinimal, p); got == nil || *got != "low" {
		t.Errorf("adaptive minimal must narrow to low, got %v", got)
	}
	if got := ToReasoningEffort(ThinkingXHigh, p); got == nil || *got != "high" {
		t.Errorf("adaptive xhigh must narrow to high, got %v", got)
	}
}

func TestToAnthropicThinkingEffortFilters(t *testing.T) {
	p := thinkingTestProvider("anthropic")
	p.ThinkingMode = "adaptive"
	// minimal narrows to low, which is a legal Anthropic effort.
	if got := ToAnthropicThinkingEffort(ThinkingMinimal, p); got == nil || *got != "low" {
		t.Errorf("minimal → %v, want low", got)
	}
	// off maps to "none", which is not a legal Anthropic effort.
	if got := ToAnthropicThinkingEffort(ThinkingOff, p); got != nil {
		t.Errorf("off must be filtered out, got %v", *got)
	}
}

func TestGetSupportedThinkingLevels(t *testing.T) {
	// Capabilities are never inferred from model names.
	for _, model := range []string{"gpt-4o", "o3", "claude-haiku", "arbitrary-model"} {
		p := thinkingTestProvider("openai")
		p.Model = model
		if got := GetSupportedThinkingLevels(p); !reflect.DeepEqual(got, ThinkingLevels) {
			t.Errorf("%s: supported = %v, want all levels", model, got)
		}
	}

	// reasoning:false only exposes off.
	p := thinkingTestProvider("openai")
	p.Reasoning = boolPtr(false)
	if got := GetSupportedThinkingLevels(p); !reflect.DeepEqual(got, []ThinkingLevel{ThinkingOff}) {
		t.Errorf("reasoning:false supported = %v, want [off]", got)
	}

	// Anthropic budget mode with an output ceiling below budget+answer minimum
	// only exposes off.
	p = thinkingTestProvider("anthropic")
	p.MaxOutputTokens = 1500
	p.ContextWindow = 100000
	if got := GetSupportedThinkingLevels(p); !reflect.DeepEqual(got, []ThinkingLevel{ThinkingOff}) {
		t.Errorf("small ceiling supported = %v, want [off]", got)
	}
}

func TestClampThinkingLevel(t *testing.T) {
	p := thinkingTestProvider("openai")
	p.Reasoning = boolPtr(false)
	if got := ClampThinkingLevel(p, ThinkingMax); got != ThinkingOff {
		t.Errorf("clamp with reasoning:false = %q, want off", got)
	}

	p = thinkingTestProvider("openai")
	p.ThinkingLevelMap = map[string]*string{"xhigh": nil, "max": nil}
	// xhigh/max disabled → requesting max clamps down to high.
	if got := ClampThinkingLevel(p, ThinkingMax); got != ThinkingHigh {
		t.Errorf("clamp = %q, want high", got)
	}
	// Lower requests are never raised.
	if got := ClampThinkingLevel(p, ThinkingLow); got != ThinkingLow {
		t.Errorf("clamp = %q, want low", got)
	}
}

func TestWithProviderDefaults(t *testing.T) {
	p := thinkingTestProvider("openai")
	out := WithProviderDefaults(*p)
	if out.Thinking != ThinkingHigh {
		t.Errorf("thinking = %q, want high", out.Thinking)
	}
	if out.MaxOutputTokens <= 0 {
		t.Errorf("max_output_tokens must be resolved, got %v", out.MaxOutputTokens)
	}
	if out.ContextWindow <= 0 {
		t.Errorf("context_window must be resolved, got %v", out.ContextWindow)
	}
	// The input stays untouched.
	if p.Thinking != "" || p.ContextWindow != 0 {
		t.Errorf("input provider mutated: %+v", p)
	}
}

func TestGetMaxOutputTokensClampedToWindow(t *testing.T) {
	p := thinkingTestProvider("openai")
	if got := p.GetMaxOutputTokens(); got != DefaultMaxOutputTokens {
		t.Errorf("default cap = %d, want %d", got, DefaultMaxOutputTokens)
	}
	p.ContextWindow = 32000
	if got := p.GetMaxOutputTokens(); got != 32000 {
		t.Errorf("cap must clamp to window, got %d", got)
	}
	p.MaxOutputTokens = 4096
	p.ContextWindow = 32000
	if got := p.GetMaxOutputTokens(); got != 4096 {
		t.Errorf("configured cap must win, got %d", got)
	}
}
