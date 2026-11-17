package config

import (
	"fmt"
	"math"

	"github.com/yukino-js/yukino/yukino/internal/storage"
)

func GlobalConfigPath() string {
	return storage.YukinoPath(GlobalConfigFilename)
}

// ExtraField is one unrecognized provider field, retained so provider-login
// round-trips preserve future capability metadata.
type ExtraField struct {
	Key   string
	Value any
}

// LevelOverride is one thinking_level_map entry: a null value disables the
// level, a string maps it to a provider-native reasoning effort.
type LevelOverride struct {
	Null   bool
	Effort string
}

type ProviderConfig struct {
	Name     string
	Protocol string
	BaseURL  string
	Model    string
	APIKey   string
	// Effective logical thinking level; empty means unset.
	Thinking string
	// Explicit capability metadata, never inferred from model names.
	Reasoning        *bool
	ThinkingLevelMap map[string]LevelOverride
	// Only Anthropic uses the adaptive mode; existing configurations use budgets.
	ThinkingMode string
	// Raw configured values; non-integer or non-positive entries fall back to
	// the defaults in GetContextWindow / GetMaxOutputTokens.
	ContextWindow   float64
	MaxOutputTokens float64
	// Unrecognized fields, retained so provider-login round-trips preserve
	// future capability metadata.
	Extra []ExtraField
}

var reasoningEfforts = map[string]bool{
	"none": true, "minimal": true, "low": true, "medium": true,
	"high": true, "xhigh": true, "max": true,
}

var anthropicEfforts = map[string]bool{
	"low": true, "medium": true, "high": true, "xhigh": true, "max": true,
}

// ResolveDefaultProvider returns the provider selected by default_provider,
// falling back to the first entry when the recorded index is out of range
// (e.g. a hand-edited config). Callers guarantee a non-empty list.
func ResolveDefaultProvider(providers []ProviderConfig, defaultProvider int) *ProviderConfig {
	if defaultProvider >= 0 && defaultProvider < len(providers) {
		return &providers[defaultProvider]
	}
	return &providers[0]
}

func IsValidThinkingLevel(value string) bool {
	for _, level := range ThinkingLevels {
		if level == value {
			return true
		}
	}
	return false
}

// GetThinkingLevel resolves the effective logical level, including explicit
// capability limits.
func GetThinkingLevel(provider *ProviderConfig) string {
	level := provider.Thinking
	if level == "" {
		level = DefaultThinkingLevel
	}
	return ClampThinkingLevel(provider, level)
}

// ThinkingBudgetForLevel returns the thinking token budget for a level; 0 when
// thinking is off.
func ThinkingBudgetForLevel(level string) int {
	if level == "off" {
		return 0
	}
	return ThinkingBudgets[level]
}

func ThinkingBudgetForProvider(provider *ProviderConfig, level string) int {
	effort := ToReasoningEffort(level, provider)
	if effort == "" || effort == "none" {
		return 0
	}
	return ThinkingBudgetForLevel(effort)
}

// ToReasoningEffort maps a logical level using configured capabilities, not
// model-name guesses. The empty string is the null (disabled) result.
func ToReasoningEffort(level string, provider *ProviderConfig) string {
	if provider != nil && provider.Reasoning != nil && !*provider.Reasoning {
		return ""
	}
	// Omitting reasoning can enable a server default. Off must explicitly
	// disable it, even when an off:null override was provided.
	if level == "off" {
		return "none"
	}
	if provider != nil && provider.ThinkingLevelMap != nil {
		if override, ok := provider.ThinkingLevelMap[level]; ok {
			if override.Null {
				return ""
			}
			return override.Effort
		}
	}
	if provider != nil && provider.Protocol == "anthropic" && provider.ThinkingMode == "adaptive" {
		switch level {
		case "minimal":
			return "low"
		case "xhigh":
			return "high"
		}
	}
	return level
}

// ToAnthropicThinkingEffort narrows adaptive efforts to the Anthropic SDK's
// legal values; the empty string is null.
func ToAnthropicThinkingEffort(level string, provider *ProviderConfig) string {
	effort := ToReasoningEffort(level, provider)
	if anthropicEfforts[effort] {
		return effort
	}
	return ""
}

// GetSupportedThinkingLevels lists the available logical levels; missing
// metadata preserves the existing defaults.
func GetSupportedThinkingLevels(provider *ProviderConfig) []string {
	if (provider.Reasoning != nil && !*provider.Reasoning) ||
		(provider.Protocol == "anthropic" && provider.ThinkingMode != "adaptive" &&
			GetMaxOutputTokens(provider) < MinThinkingBudgetTokens+MinThinkingAnswerTokens) {
		return []string{"off"}
	}
	supported := make([]string, 0, len(ThinkingLevels))
	for _, level := range ThinkingLevels {
		if level == "off" {
			supported = append(supported, level)
			continue
		}
		if provider.Protocol == "anthropic" && provider.ThinkingMode == "adaptive" {
			if ToAnthropicThinkingEffort(level, provider) != "" {
				supported = append(supported, level)
			}
			continue
		}
		effort := ToReasoningEffort(level, provider)
		if effort != "" && effort != "none" {
			supported = append(supported, level)
		}
	}
	return supported
}

// ClampThinkingLevel lowers unsupported requests to the nearest available
// level, never higher.
func ClampThinkingLevel(provider *ProviderConfig, level string) string {
	supported := map[string]bool{}
	for _, candidate := range GetSupportedThinkingLevels(provider) {
		supported[candidate] = true
	}
	effective := "off"
	for _, candidate := range ThinkingLevels {
		if supported[candidate] {
			effective = candidate
		}
		if candidate == level {
			break
		}
	}
	return effective
}

func WithProviderDefaults(provider ProviderConfig) ProviderConfig {
	out := provider
	out.Thinking = GetThinkingLevel(&provider)
	out.ContextWindow = float64(GetContextWindow(&provider))
	out.MaxOutputTokens = float64(GetMaxOutputTokens(&provider))
	return out
}

func isSafeInteger(value float64) bool {
	return value == math.Trunc(value) && math.Abs(value) <= float64(1<<53)
}

func GetContextWindow(provider *ProviderConfig) int {
	if isSafeInteger(provider.ContextWindow) && provider.ContextWindow > 0 {
		return int(provider.ContextWindow)
	}
	return DefaultContextWindow
}

// GetMaxOutputTokens returns the effective output cap for a provider. The
// configured value wins, otherwise the 128k fallback applies; the result never
// exceeds the context window (PI's clampMaxTokensToContext).
func GetMaxOutputTokens(provider *ProviderConfig) int {
	maxOutput := DefaultMaxOutputTokens
	if isSafeInteger(provider.MaxOutputTokens) && provider.MaxOutputTokens > 0 {
		maxOutput = int(provider.MaxOutputTokens)
	}
	if window := GetContextWindow(provider); maxOutput > window {
		return window
	}
	return maxOutput
}

func parseProviderConfig(raw map[string]any) (ProviderConfig, error) {
	var p ProviderConfig
	var err error
	for key, value := range raw {
		if !providerKnownKeys[key] {
			p.Extra = append(p.Extra, ExtraField{Key: key, Value: value})
		}
	}
	if p.Name, err = requireString(raw, "name"); err != nil {
		return p, err
	}
	if p.Protocol, err = requireString(raw, "protocol"); err != nil {
		return p, err
	}
	if !ValidProtocols[p.Protocol] {
		return p, fmt.Errorf("protocol: invalid enum value '%s'", p.Protocol)
	}
	if p.BaseURL, err = requireString(raw, "base_url"); err != nil {
		return p, err
	}
	if p.Model, err = requireString(raw, "model"); err != nil {
		return p, err
	}
	if v, ok, err := optionalValue(raw, "api_key"); err != nil {
		return p, err
	} else if ok {
		if p.APIKey, err = asString(v); err != nil {
			return p, fmt.Errorf("api_key: %w", err)
		}
	}
	if v, ok, err := optionalValue(raw, "thinking"); err != nil {
		return p, err
	} else if ok {
		level, err := asString(v)
		if err != nil {
			return p, fmt.Errorf("thinking: expected a thinking level string, got %T", v)
		}
		if !IsValidThinkingLevel(level) {
			return p, fmt.Errorf("thinking: invalid enum value '%s'", level)
		}
		p.Thinking = level
	}
	if v, ok, err := optionalValue(raw, "reasoning"); err != nil {
		return p, err
	} else if ok {
		reasoning, err := asBool(v)
		if err != nil {
			return p, fmt.Errorf("reasoning: %w", err)
		}
		p.Reasoning = &reasoning
	}
	if v, ok, err := optionalValue(raw, "thinking_level_map"); err != nil {
		return p, err
	} else if ok {
		block, ok := v.(map[string]any)
		if !ok {
			return p, fmt.Errorf("thinking_level_map: expected a mapping, got %T", v)
		}
		p.ThinkingLevelMap = map[string]LevelOverride{}
		for key, entry := range block {
			if !IsValidThinkingLevel(key) {
				return p, fmt.Errorf("thinking_level_map: unrecognized level '%s'", key)
			}
			if entry == nil {
				p.ThinkingLevelMap[key] = LevelOverride{Null: true}
				continue
			}
			effort, err := asString(entry)
			if err != nil {
				return p, fmt.Errorf("thinking_level_map.%s: expected a reasoning effort string or null", key)
			}
			if !reasoningEfforts[effort] {
				return p, fmt.Errorf("thinking_level_map.%s: invalid effort '%s'", key, effort)
			}
			if key == "off" && effort != "none" {
				return p, fmt.Errorf("thinking_level_map.off: only 'none' or null is allowed")
			}
			p.ThinkingLevelMap[key] = LevelOverride{Effort: effort}
		}
	}
	if v, ok, err := optionalValue(raw, "thinking_mode"); err != nil {
		return p, err
	} else if ok {
		mode, err := asString(v)
		if err != nil || (mode != "budget" && mode != "adaptive") {
			return p, fmt.Errorf("thinking_mode: invalid enum value '%v'", v)
		}
		p.ThinkingMode = mode
	}
	if v, ok, err := optionalValue(raw, "context_window"); err != nil {
		return p, err
	} else if ok {
		if p.ContextWindow, err = asCoercedNumber(v); err != nil {
			return p, fmt.Errorf("context_window: %w", err)
		}
	}
	if v, ok, err := optionalValue(raw, "max_output_tokens"); err != nil {
		return p, err
	} else if ok {
		if p.MaxOutputTokens, err = asCoercedNumber(v); err != nil {
			return p, fmt.Errorf("max_output_tokens: %w", err)
		}
	}
	return p, nil
}

var providerKnownKeys = map[string]bool{
	"name": true, "protocol": true, "base_url": true, "model": true,
	"api_key": true, "thinking": true, "reasoning": true,
	"thinking_level_map": true, "thinking_mode": true,
	"context_window": true, "max_output_tokens": true,
}
