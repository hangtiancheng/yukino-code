package workflow

import (
	"encoding/json"
	"fmt"
)

// WorkflowInput is the validated Workflow tool input.
type WorkflowInput struct {
	Script          string
	Name            string
	ScriptPath      string
	Args            any
	HasArgs         bool
	ResumeFromRunID string
	Description     string
	Title           string
	MaxConcurrency  *int
}

// ParseWorkflowInput validates the raw tool arguments, mirroring
// workflowInputSchema including its superRefine source rule.
func ParseWorkflowInput(raw map[string]any) (*WorkflowInput, error) {
	input := &WorkflowInput{}
	sources := 0
	if value, ok := raw["script"]; ok && value != nil {
		text, ok := value.(string)
		if !ok || text == "" {
			return nil, fmt.Errorf("script must be a non-empty string")
		}
		input.Script = text
		sources++
	}
	if value, ok := raw["name"]; ok && value != nil {
		text, ok := value.(string)
		if !ok || text == "" {
			return nil, fmt.Errorf("name must be a non-empty string")
		}
		input.Name = text
		sources++
	}
	if value, ok := raw["scriptPath"]; ok && value != nil {
		text, ok := value.(string)
		if !ok || text == "" {
			return nil, fmt.Errorf("scriptPath must be a non-empty string")
		}
		input.ScriptPath = text
		sources++
	}
	if value, ok := raw["args"]; ok {
		input.Args = value
		input.HasArgs = true
	}
	if value, ok := raw["resumeFromRunId"]; ok && value != nil {
		text, ok := value.(string)
		if !ok || !RunIDRe.MatchString(text) {
			return nil, fmt.Errorf("resumeFromRunId must match %s", RunIDRe.String())
		}
		input.ResumeFromRunID = text
	}
	if value, ok := raw["description"]; ok && value != nil {
		text, ok := value.(string)
		if !ok {
			return nil, fmt.Errorf("description must be a string")
		}
		input.Description = text
	}
	if value, ok := raw["title"]; ok && value != nil {
		text, ok := value.(string)
		if !ok {
			return nil, fmt.Errorf("title must be a string")
		}
		input.Title = text
	}
	if value, ok := raw["maxConcurrency"]; ok && value != nil {
		number, err := toInt(value)
		if err != nil || number < 1 || number > MaxConcurrencyCap {
			return nil, fmt.Errorf("maxConcurrency must be an integer between 1 and %d", MaxConcurrencyCap)
		}
		input.MaxConcurrency = &number
	}
	if sources > 1 || (sources == 0 && input.ResumeFromRunID == "") {
		return nil, fmt.Errorf("Provide exactly one of script, name or scriptPath, or resumeFromRunId to reuse a saved script.")
	}
	return input, nil
}

func toInt(value any) (int, error) {
	switch v := value.(type) {
	case int:
		return v, nil
	case int64:
		return int(v), nil
	case float64:
		if v != float64(int(v)) {
			return 0, fmt.Errorf("not an integer")
		}
		return int(v), nil
	case json.Number:
		n, err := v.Int64()
		if err != nil {
			return 0, err
		}
		return int(n), nil
	default:
		return 0, fmt.Errorf("not a number")
	}
}

func toString(value any) (string, bool) {
	text, ok := value.(string)
	return text, ok
}

// ParseAgentRunParams validates agent() options, mirroring
// agentRunParamsSchema.
func ParseAgentRunParams(prompt string, opts map[string]any) (*AgentRunParams, error) {
	params := &AgentRunParams{Prompt: prompt}
	if value, ok := opts["schema"]; ok && value != nil {
		schema, ok := value.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("schema must be an object")
		}
		params.Schema = schema
	}
	if value, ok := opts["model"]; ok && value != nil {
		text, ok := toString(value)
		if !ok {
			return nil, fmt.Errorf("model must be a string")
		}
		params.Model = text
	}
	if value, ok := opts["maxTokens"]; ok && value != nil {
		number, err := toInt(value)
		if err != nil || number <= 0 {
			return nil, fmt.Errorf("maxTokens must be a positive integer")
		}
		params.MaxTokens = number
	}
	if value, ok := opts["agentType"]; ok && value != nil {
		text, ok := toString(value)
		if !ok {
			return nil, fmt.Errorf("agentType must be a string")
		}
		params.AgentType = text
	}
	if value, ok := opts["isolation"]; ok && value != nil {
		text, ok := toString(value)
		if !ok || text != "worktree" {
			return nil, fmt.Errorf("isolation must be the literal \"worktree\"")
		}
		params.Isolation = text
	}
	if value, ok := opts["allowedTools"]; ok && value != nil {
		list, ok := value.([]any)
		if !ok {
			return nil, fmt.Errorf("allowedTools must be an array of strings")
		}
		for _, item := range list {
			text, ok := toString(item)
			if !ok {
				return nil, fmt.Errorf("allowedTools must be an array of strings")
			}
			params.AllowedTools = append(params.AllowedTools, text)
		}
	}
	if value, ok := opts["label"]; ok && value != nil {
		text, ok := toString(value)
		if !ok {
			return nil, fmt.Errorf("label must be a string")
		}
		params.Label = text
	}
	if value, ok := opts["phase"]; ok && value != nil {
		text, ok := toString(value)
		if !ok {
			return nil, fmt.Errorf("phase must be a string")
		}
		params.Phase = text
	}
	return params, nil
}

// ParseJournalEntry validates a persisted journal line, mirroring
// journalEntrySchema.
func ParseJournalEntry(raw map[string]any) (*JournalEntry, error) {
	key, ok := toString(raw["key"])
	if !ok {
		return nil, fmt.Errorf("journal entry key must be a string")
	}
	seqValue, ok := raw["seq"]
	if !ok {
		return nil, fmt.Errorf("journal entry seq is required")
	}
	seq, err := toInt(seqValue)
	if err != nil || seq < 0 {
		return nil, fmt.Errorf("journal entry seq must be a nonnegative integer")
	}
	resultRaw, ok := raw["result"].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("journal entry result must be an object")
	}
	result, err := parseAgentRunResult(resultRaw)
	if err != nil {
		return nil, err
	}
	return &JournalEntry{Key: key, Seq: seq, Result: result}, nil
}

func parseAgentRunResult(raw map[string]any) (AgentRunResult, error) {
	kind, _ := toString(raw["kind"])
	switch kind {
	case "ok":
		result := AgentRunResult{Kind: "ok", Output: raw["output"]}
		usage, ok := raw["usage"].(map[string]any)
		if !ok {
			return result, fmt.Errorf("ok result requires a usage object")
		}
		outputTokens, err := toInt(usage["outputTokens"])
		if err != nil || outputTokens < 0 {
			return result, fmt.Errorf("usage.outputTokens must be nonnegative")
		}
		result.Usage = &struct {
			OutputTokens int `json:"outputTokens"`
		}{OutputTokens: outputTokens}
		if value, ok := raw["model"]; ok {
			if text, ok := toString(value); ok {
				result.Model = text
			}
		}
		if value, ok := raw["toolCount"]; ok {
			if number, err := toInt(value); err == nil {
				result.ToolCount = &number
			}
		}
		if value, ok := raw["tokenCount"]; ok {
			if number, err := toInt(value); err == nil {
				result.TokenCount = &number
			}
		}
		return result, nil
	case "skipped":
		return AgentRunResult{Kind: "skipped"}, nil
	case "dead":
		result := AgentRunResult{Kind: "dead"}
		if value, ok := raw["reason"]; ok && value != nil {
			reason, ok := toString(value)
			if !ok {
				return result, fmt.Errorf("dead reason must be a string")
			}
			switch reason {
			case "no-structured-output", "invalid-structured-output", "run-agent-threw", "worktree-failed", "unknown":
			default:
				return result, fmt.Errorf("invalid dead reason %q", reason)
			}
			result.Reason = reason
		}
		if value, ok := raw["detail"]; ok && value != nil {
			detail, ok := toString(value)
			if !ok {
				return result, fmt.Errorf("dead detail must be a string")
			}
			result.Detail = detail
		}
		return result, nil
	default:
		return AgentRunResult{}, fmt.Errorf("unknown result kind %q", kind)
	}
}
