package tools

import (
	"context"
	"fmt"
	"strings"
)

type QuestionOption struct {
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
}

type Question struct {
	Text        string           `json:"question"`
	Options     []QuestionOption `json:"options"`
	MultiSelect bool             `json:"multiSelect"`
}

type QuestionRequest struct {
	Questions []Question
}

type QuestionResponse struct {
	Answers map[string]string
}

type AskUserQuestionTool struct {
	RequestCh chan<- AskUserRequest
}

type AskUserRequest struct {
	Context    context.Context
	Questions  []Question
	ResponseCh chan QuestionResponse
}

func (t *AskUserQuestionTool) Name() string { return "AskUserQuestion" }

func (t *AskUserQuestionTool) Description() string { return AskUserQuestionDescription }

func (t *AskUserQuestionTool) Category() ToolCategory { return CategoryRead }

func (t *AskUserQuestionTool) Schema() map[string]any {
	return map[string]any{
		"name":        t.Name(),
		"description": t.Description(),
		"input_schema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"questions": map[string]any{
					"type":        "array",
					"description": AskUserQuestionsDescription,
					"minItems":    1,
					"maxItems":    4,
					"items": map[string]any{
						"type": "object",
						"properties": map[string]any{
							"question": map[string]any{
								"type":        "string",
								"description": AskUserQuestionTextDescription,
							},
							"options": map[string]any{
								"type":        "array",
								"description": AskUserOptionsDescription,
								"minItems":    2,
								"maxItems":    4,
								"items": map[string]any{
									"type": "object",
									"properties": map[string]any{
										"label":       map[string]any{"type": "string", "description": AskUserOptionLabelDescription},
										"description": map[string]any{"type": "string", "description": AskUserOptionDescriptionDescription},
									},
									"required": []string{"label"},
								},
							},
							"multiSelect": map[string]any{
								"type":        "boolean",
								"description": AskUserMultiSelectDescription,
							},
						},
						"required":             []string{"question", "options", "multiSelect"},
						"additionalProperties": false,
					},
				},
			},
			"required": []string{"questions"},
		},
	}
}

func (t *AskUserQuestionTool) Execute(ctx context.Context, args map[string]any) ToolResult {
	questionsRaw, exists := args["questions"]
	if !exists {
		return ToolResult{Output: "Invalid arguments: questions is required", IsError: true}
	}
	list, ok := questionsRaw.([]any)
	if !ok {
		return ToolResult{Output: "Invalid arguments: questions must be an array", IsError: true}
	}
	var questions []Question
	seen := map[string]bool{}
	for _, raw := range list {
		entry, ok := raw.(map[string]any)
		if !ok {
			return ToolResult{Output: "Invalid arguments: question must be an object", IsError: true}
		}
		for key := range entry {
			if key != "question" && key != "options" && key != "multiSelect" {
				return ToolResult{Output: "Invalid arguments: unknown question field " + key, IsError: true}
			}
		}
		text, ok := entry["question"].(string)
		if !ok {
			return ToolResult{Output: "Invalid arguments: question must be a string", IsError: true}
		}
		if seen[text] {
			return ToolResult{Output: "Invalid arguments: duplicate question " + text, IsError: true}
		}
		seen[text] = true
		multiSelect, ok := entry["multiSelect"].(bool)
		if !ok {
			return ToolResult{Output: "Invalid arguments: multiSelect must be a boolean", IsError: true}
		}
		optionsRaw, ok := entry["options"].([]any)
		if !ok {
			return ToolResult{Output: "Invalid arguments: options must be an array", IsError: true}
		}
		question := Question{Text: text, MultiSelect: multiSelect}
		for _, optionRaw := range optionsRaw {
			option, ok := optionRaw.(map[string]any)
			if !ok {
				return ToolResult{Output: "Invalid arguments: option must be an object", IsError: true}
			}
			label, ok := option["label"].(string)
			if !ok {
				return ToolResult{Output: "Invalid arguments: option label must be a string", IsError: true}
			}
			description := ""
			if value, present := option["description"]; present {
				var isString bool
				description, isString = value.(string)
				if !isString {
					return ToolResult{Output: "Invalid arguments: option description must be a string", IsError: true}
				}
			}
			question.Options = append(question.Options, QuestionOption{Label: label, Description: description})
		}
		questions = append(questions, question)
	}

	if len(questions) < 1 || len(questions) > 4 {
		return ToolResult{Output: QuestionCountError, IsError: true}
	}
	for _, question := range questions {
		if len(question.Options) < 2 || len(question.Options) > 4 {
			return ToolResult{Output: fmt.Sprintf("Error: question '%s' must have 2-4 options", question.Text), IsError: true}
		}
	}
	if ctx.Err() != nil {
		return ToolResult{Output: OperationInterruptedError, IsError: true}
	}
	if t.RequestCh == nil {
		return ToolResult{Output: "Error: AskUserQuestion not available in this context", IsError: true}
	}

	responseCh := make(chan QuestionResponse, 1)
	select {
	case t.RequestCh <- AskUserRequest{Context: ctx, Questions: questions, ResponseCh: responseCh}:
	case <-ctx.Done():
		return ToolResult{Output: OperationInterruptedError, IsError: true}
	}

	select {
	case response := <-responseCh:
		if len(response.Answers) == 0 || response.Answers["_declined"] == "true" {
			return ToolResult{Output: "User cancelled or did not answer the questions.", IsError: true}
		}
		var parts []string
		for _, question := range questions {
			if answer, ok := response.Answers[question.Text]; ok {
				parts = append(parts, fmt.Sprintf("\"%s\" = \"%s\"", question.Text, answer))
			}
		}
		return ToolResult{Output: "User has answered your questions: " + strings.Join(parts, ", ") + ". You can now continue with the user's answers"}
	case <-ctx.Done():
		return ToolResult{Output: OperationInterruptedError, IsError: true}
	}
}
