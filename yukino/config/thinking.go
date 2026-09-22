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
	"fmt"
	"strings"
)

// ThinkingLevel is a PI-equivalent logical reasoning level. Off disables
// reasoning entirely; the rest map to a provider-native effort string
// (openai / openai-compat) or a thinking token budget (anthropic).
type ThinkingLevel string

const (
	ThinkingOff     ThinkingLevel = "off"
	ThinkingMinimal ThinkingLevel = "minimal"
	ThinkingLow     ThinkingLevel = "low"
	ThinkingMedium  ThinkingLevel = "medium"
	ThinkingHigh    ThinkingLevel = "high"
	ThinkingXHigh   ThinkingLevel = "xhigh"
	ThinkingMax     ThinkingLevel = "max"
)

// ThinkingLevels lists all logical levels in ascending order.
var ThinkingLevels = []ThinkingLevel{
	ThinkingOff,
	ThinkingMinimal,
	ThinkingLow,
	ThinkingMedium,
	ThinkingHigh,
	ThinkingXHigh,
	ThinkingMax,
}

// DefaultThinkingLevel applies when the provider does not configure one.
const DefaultThinkingLevel = ThinkingHigh

// DefaultContextWindow is the fallback context window (TS:
// DEFAULT_CONTEXT_WINDOW). TS applies it whenever context_window is unset or
// non-positive; there is no model-name inference.
const DefaultContextWindow = 1_000_000

// DefaultMaxOutputTokens is the fallback output-token ceiling used when
// max_output_tokens is unset (PI's custom-model maxTokens default).
const DefaultMaxOutputTokens = 128_000

// ThinkingBudgets are the PI-equivalent thinking token budgets used by the
// anthropic budget-based thinking path. They stay below
// DefaultMaxOutputTokens so the answer keeps room after the thinking budget
// is reserved.
var ThinkingBudgets = map[ThinkingLevel]int{
	ThinkingMinimal: 1024,
	ThinkingLow:     2048,
	ThinkingMedium:  8192,
	ThinkingHigh:    16384,
	ThinkingXHigh:   32768,
	ThinkingMax:     65536,
}

const (
	MinThinkingBudgetTokens = 1024
	MinThinkingAnswerTokens = 1024
)

// IsValidThinkingLevel reports whether value is a known logical level.
func IsValidThinkingLevel(value string) bool {
	for _, level := range ThinkingLevels {
		if string(level) == value {
			return true
		}
	}
	return false
}

// GetThinkingLevel resolves the effective logical level, including explicit
// capability limits.
func GetThinkingLevel(p *ProviderConfig) ThinkingLevel {
	level := p.Thinking
	if !IsValidThinkingLevel(string(level)) {
		level = DefaultThinkingLevel
	}
	return ClampThinkingLevel(p, level)
}

// ThinkingBudgetForLevel returns the thinking token budget for a level; 0
// when thinking is off.
func ThinkingBudgetForLevel(level ThinkingLevel) int {
	if level == ThinkingOff {
		return 0
	}
	return ThinkingBudgets[level]
}

// ToReasoningEffort maps a logical level using configured capabilities, not
// model-name guesses. It returns nil when the provider explicitly cannot
// reason (reasoning: false) or when a thinking_level_map entry disables the
// level with null.
func ToReasoningEffort(level ThinkingLevel, p *ProviderConfig) *string {
	if p != nil && p.Reasoning != nil && !*p.Reasoning {
		return nil
	}
	// Omitting reasoning can enable a server default. Off must explicitly
	// disable it, even when an off:null override was provided.
	if level == ThinkingOff {
		return effortPtr("none")
	}
	if p != nil && p.ThinkingLevelMap != nil {
		if mapped, ok := p.ThinkingLevelMap[string(level)]; ok {
			return mapped
		}
	}
	if p != nil && p.Protocol == "anthropic" && p.ThinkingMode == "adaptive" {
		if level == ThinkingMinimal {
			return effortPtr("low")
		}
		if level == ThinkingXHigh {
			return effortPtr("high")
		}
	}
	return effortPtr(string(level))
}

// ToAnthropicThinkingEffort narrows adaptive efforts to the Anthropic SDK's
// legal values (low/medium/high/xhigh/max).
func ToAnthropicThinkingEffort(level ThinkingLevel, p *ProviderConfig) *string {
	effort := ToReasoningEffort(level, p)
	if effort == nil {
		return nil
	}
	switch *effort {
	case "low", "medium", "high", "xhigh", "max":
		return effort
	default:
		return nil
	}
}

// GetSupportedThinkingLevels lists the available logical levels; missing
// metadata preserves the existing defaults.
func GetSupportedThinkingLevels(p *ProviderConfig) []ThinkingLevel {
	reasoningDisabled := p.Reasoning != nil && !*p.Reasoning
	budgetTooSmall := p.Protocol == "anthropic" &&
		p.ThinkingMode != "adaptive" &&
		p.GetMaxOutputTokens() < MinThinkingBudgetTokens+MinThinkingAnswerTokens
	if reasoningDisabled || budgetTooSmall {
		return []ThinkingLevel{ThinkingOff}
	}

	supported := make([]ThinkingLevel, 0, len(ThinkingLevels))
	for _, level := range ThinkingLevels {
		if level == ThinkingOff {
			supported = append(supported, level)
			continue
		}
		if p.Protocol == "anthropic" && p.ThinkingMode == "adaptive" {
			if ToAnthropicThinkingEffort(level, p) != nil {
				supported = append(supported, level)
			}
			continue
		}
		effort := ToReasoningEffort(level, p)
		if effort != nil && *effort != "none" {
			supported = append(supported, level)
		}
	}
	return supported
}

// ClampThinkingLevel lowers unsupported requests to the nearest available
// level, never higher.
func ClampThinkingLevel(p *ProviderConfig, level ThinkingLevel) ThinkingLevel {
	supported := GetSupportedThinkingLevels(p)
	inSupported := func(candidate ThinkingLevel) bool {
		for _, s := range supported {
			if s == candidate {
				return true
			}
		}
		return false
	}
	effective := ThinkingOff
	for _, candidate := range ThinkingLevels {
		if inSupported(candidate) {
			effective = candidate
		}
		if candidate == level {
			break
		}
	}
	return effective
}

// WithProviderDefaults returns a copy of the provider with thinking,
// context_window and max_output_tokens resolved to their effective values.
func WithProviderDefaults(p ProviderConfig) ProviderConfig {
	out := p
	out.Thinking = GetThinkingLevel(&out)
	out.ContextWindow = float64(p.GetContextWindow())
	out.MaxOutputTokens = float64(p.GetMaxOutputTokens())
	return out
}

func effortPtr(value string) *string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

// validReasoningEfforts are the provider-native effort strings a
// thinking_level_map entry may select (TS: ReasoningEffortSchema).
var validReasoningEfforts = map[string]bool{
	"none": true, "minimal": true, "low": true, "medium": true,
	"high": true, "xhigh": true, "max": true,
}

// validateThinkingMetadata rejects malformed capability metadata the same way
// the TS ProviderConfigSchema does: unknown levels, unknown thinking modes,
// and thinking_level_map entries with unknown keys, non-effort values, or an
// off mapping that would enable reasoning.
func validateThinkingMetadata(index int, p ProviderConfig) error {
	position := fmt.Sprintf("Provider #%d", index+1)
	if p.Thinking != "" && !IsValidThinkingLevel(string(p.Thinking)) {
		return &ConfigError{Message: fmt.Sprintf(
			"%s: invalid thinking level '%s'.", position, p.Thinking)}
	}
	if p.ThinkingMode != "" && p.ThinkingMode != "budget" && p.ThinkingMode != "adaptive" {
		return &ConfigError{Message: fmt.Sprintf(
			"%s: invalid thinking_mode '%s', must be budget or adaptive.", position, p.ThinkingMode)}
	}
	for key, value := range p.ThinkingLevelMap {
		if !IsValidThinkingLevel(key) {
			return &ConfigError{Message: fmt.Sprintf(
				"%s: thinking_level_map key '%s' is not a valid level.", position, key)}
		}
		if value == nil {
			continue
		}
		if !validReasoningEfforts[*value] {
			return &ConfigError{Message: fmt.Sprintf(
				"%s: thinking_level_map.%s value '%s' is not a valid effort.", position, key, *value)}
		}
		if key == string(ThinkingOff) && *value != "none" {
			return &ConfigError{Message: fmt.Sprintf(
				"%s: thinking_level_map.off must be null or \"none\".", position)}
		}
	}
	return nil
}
