package config

// PI-equivalent thinking levels. "off" disables reasoning entirely; the rest
// map to a provider-native effort string (openai / openai-compat, and
// anthropic in adaptive mode) or a thinking token budget (anthropic in budget
// mode).
var ThinkingLevels = []string{"off", "minimal", "low", "medium", "high", "xhigh", "max"}

const (
	DefaultThinkingLevel = "high"
	DefaultContextWindow = 1_000_000
	// Fallback output-token ceiling used when max_output_tokens is unset (PI's
	// custom-model maxTokens default).
	DefaultMaxOutputTokens = 128_000

	MinThinkingBudgetTokens = 1024
	MinThinkingAnswerTokens = 1024

	GlobalConfigFilename = "config.yaml"
	// Project-level MCP config file, compatible with the Claude Code format.
	ProjectMCPFilename = ".mcp.json"

	NoProvidersError = "At least one provider MUST be configured."
	YAMLParseError   = "YAML parse error"
)

// PI-equivalent thinking token budgets, used by the anthropic budget-based
// thinking path. Must stay below DefaultMaxOutputTokens so the answer keeps
// room after the thinking budget is reserved.
var ThinkingBudgets = map[string]int{
	"minimal": 1024,
	"low":     2048,
	"medium":  8192,
	"high":    16384,
	"xhigh":   32768,
	"max":     65536,
}

var EnvKeyMap = map[string]string{
	"anthropic":     "ANTHROPIC_API_KEY",
	"openai":        "OPENAI_API_KEY",
	"openai-compat": "OPENAI_API_KEY",
}

var ValidProtocols = map[string]bool{
	"anthropic":     true,
	"openai":        true,
	"openai-compat": true,
}

var MCPLoadingModes = []string{"auto", "eager", "native", "dispatch"}
var ThemeModes = []string{"auto", "dark", "light"}
