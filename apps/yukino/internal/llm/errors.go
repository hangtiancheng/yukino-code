package llm

import "regexp"

type LLMError struct {
	Message string
}

func (e *LLMError) Error() string { return e.Message }

type AuthenticationError struct {
	Message string
}

func (e *AuthenticationError) Error() string { return e.Message }

type RateLimitError struct {
	Message    string
	RetryAfter string
}

func (e *RateLimitError) Error() string { return e.Message }

type NetworkError struct {
	Message string
}

func (e *NetworkError) Error() string { return e.Message }

type ServerError struct {
	Message    string
	RetryAfter string
}

func (e *ServerError) Error() string { return e.Message }

type ContextTooLongError struct {
	Message string
}

func (e *ContextTooLongError) Error() string { return e.Message }

var contextLengthPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)context_length_exceeded`),
	regexp.MustCompile(`(?i)maximum\s+context\s+length`),
	regexp.MustCompile(`(?i)prompts?\s+(?:is\s+)?too\s+long`),
}

// ContainsContextLengthError detects provider "context too long" failures
// across protocols by message. Anthropic returns 400 invalid_request_error
// with "prompt is too long: N tokens > M maximum"; OpenAI (and OpenAI-
// compatible gateways such as DeepSeek) use the context_length_exceeded code
// or "maximum context length is N tokens" wording.
func ContainsContextLengthError(msg string) bool {
	for _, pattern := range contextLengthPatterns {
		if pattern.MatchString(msg) {
			return true
		}
	}
	return false
}
