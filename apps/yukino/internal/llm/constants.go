package llm

import (
	"time"

	"github.com/yukino-js/yukino/yukino/internal/config"
	"github.com/yukino-js/yukino/yukino/internal/storage"
)

const (
	DiscoveryTimeout          = 5 * time.Second
	MaxModelPages             = 10
	AnthropicAPIVersion       = "2023-06-01"
	ModelDiscoveryFailedError = "Model discovery failed"

	MaxRetries         = 3
	MaxDelay           = 60 * time.Second
	BackoffBaseDelay   = 1 * time.Second
	RateLimitBaseDelay = 5 * time.Second
)

var globalConfigPathHint = "~/" + storage.YukinoDirName + "/" + config.GlobalConfigFilename

var (
	AnthropicAPIKeyMissingError = "Anthropic API key not found, set ANTHROPIC_API_KEY in " + globalConfigPathHint + ", or via ANTHROPIC_API_KEY env variable."
	OpenAIAPIKeyMissingError    = "OpenAI API key not found, set OPENAI_API_KEY in " + globalConfigPathHint + ", or via OPENAI_API_KEY env variable."
)
