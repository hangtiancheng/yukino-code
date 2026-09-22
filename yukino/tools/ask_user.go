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

package tools

import (
	"context"
	"fmt"
	"strings"
)

type QuestionOption struct {
	Label       string `json:"label"`
	Description string `json:"description"`
}

type Question struct {
	Text        string           `json:"question"`
	Header      string           `json:"header"`
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
	Questions  []Question
	ResponseCh chan QuestionResponse
}

func (t *AskUserQuestionTool) Name() string { return "AskUserQuestion" }

func (t *AskUserQuestionTool) Description() string {
	// Byte-identical to the TS template literal, including its indentation.
	return "\n  Ask the user 1 to 4 single-choice or multiple-choices questions and wait for their answers. Each question needs 1 to 4 options; an \"Other\" option for custom input is added automatically.\n  Set multiSelect=true when the user may choose multiple options, or false for one mutually exclusive choice. Ask only for missing information that changes the task; do not re-request authorization already given.\n  "
}

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
					"description": "question",
					"minItems":    1,
					"maxItems":    4,
					"items": map[string]any{
						"type": "object",
						"properties": map[string]any{
							"question": map[string]any{
								"type":        "string",
								"description": "The question to ask",
							},
							"header": map[string]any{
								"type":        "string",
								"description": "Short label/category (<=12 chars)",
							},
							"options": map[string]any{
								"type":        "array",
								"description": "options",
								"minItems":    2,
								"maxItems":    4,
								"items": map[string]any{
									"type": "object",
									"properties": map[string]any{
										"label":       map[string]any{"type": "string", "description": "label"},
										"description": map[string]any{"type": "string", "description": "description"},
									},
									// TS requires only label; description is optional.
									"required": []string{"label"},
								},
							},
							"multiSelect": map[string]any{
								"type":        "boolean",
								"description": "Set to true for multiple-choice, false for single-choice",
							},
						},
						"required": []string{"question", "header", "options", "multiSelect"},
					},
				},
			},
			"required": []string{"questions"},
		},
	}
}

func (t *AskUserQuestionTool) Execute(ctx context.Context, args map[string]any) ToolResult {
	questionsRaw, ok := args["questions"]
	if !ok {
		return ToolResult{Output: "Error: questions is required", IsError: true}
	}

	// zod-equivalent rejection: every question must carry question/header text,
	// an options array and a boolean multiSelect, and every option a label
	// (description optional). A missing field is rejected instead of silently
	// defaulting (TS: safeParseAsync(QuestionSchema)).
	rawList, ok := questionsRaw.([]any)
	if !ok {
		return ToolResult{Output: "Error: invalid questions format: expected an array", IsError: true}
	}
	questions := make([]Question, 0, len(rawList))
	for i, item := range rawList {
		record, ok := item.(map[string]any)
		if !ok {
			return ToolResult{Output: fmt.Sprintf("Error: invalid questions format: question %d is not an object", i), IsError: true}
		}
		text, ok := record["question"].(string)
		if !ok {
			return ToolResult{Output: fmt.Sprintf("Error: invalid questions format: question %d is missing a string 'question'", i), IsError: true}
		}
		header, ok := record["header"].(string)
		if !ok {
			return ToolResult{Output: fmt.Sprintf("Error: invalid questions format: question %d is missing a string 'header'", i), IsError: true}
		}
		multiSelect, ok := record["multiSelect"].(bool)
		if !ok {
			return ToolResult{Output: fmt.Sprintf("Error: invalid questions format: question %d is missing a boolean 'multiSelect'", i), IsError: true}
		}
		optionsRaw, ok := record["options"].([]any)
		if !ok {
			return ToolResult{Output: fmt.Sprintf("Error: invalid questions format: question %d is missing an 'options' array", i), IsError: true}
		}
		options := make([]QuestionOption, 0, len(optionsRaw))
		for j, optionRaw := range optionsRaw {
			optionRecord, ok := optionRaw.(map[string]any)
			if !ok {
				return ToolResult{Output: fmt.Sprintf("Error: invalid questions format: question %d option %d is not an object", i, j), IsError: true}
			}
			label, ok := optionRecord["label"].(string)
			if !ok {
				return ToolResult{Output: fmt.Sprintf("Error: invalid questions format: question %d option %d is missing a string 'label'", i, j), IsError: true}
			}
			// zod: description is z.string().optional() — absent is fine, but
			// a present non-string (including null) is rejected.
			var description string
			if raw, present := optionRecord["description"]; present {
				description, ok = raw.(string)
				if !ok {
					return ToolResult{Output: fmt.Sprintf("Error: invalid questions format: question %d option %d has a non-string 'description'", i, j), IsError: true}
				}
			}
			options = append(options, QuestionOption{Label: label, Description: description})
		}
		questions = append(questions, Question{
			Text:        text,
			Header:      header,
			Options:     options,
			MultiSelect: multiSelect,
		})
	}

	if len(questions) == 0 || len(questions) > 4 {
		return ToolResult{Output: "Error: must have 1-4 questions", IsError: true}
	}

	for _, q := range questions {
		if len(q.Options) < 2 || len(q.Options) > 4 {
			return ToolResult{Output: fmt.Sprintf("Error: question '%s' must have 2-4 options", q.Text), IsError: true}
		}
	}

	if t.RequestCh == nil {
		return ToolResult{Output: "Error: AskUserQuestion not available in this context", IsError: true}
	}

	respCh := make(chan QuestionResponse, 1)
	t.RequestCh <- AskUserRequest{
		Questions:  questions,
		ResponseCh: respCh,
	}

	select {
	case resp := <-respCh:
		// Iterate the questions, not the answer map: Go map order is random
		// where TS Object.entries follows the dialog's construction order.
		// TS embeds the raw texts in `"q" = "a"` (template literal, no
		// escaping) — %q would add Go quoting for embedded quotes/backslashes.
		parts := make([]string, 0, len(questions))
		for _, q := range questions {
			answer, ok := resp.Answers[q.Text]
			if !ok {
				continue
			}
			parts = append(parts, `"`+q.Text+`" = "`+answer+`"`)
		}
		return ToolResult{
			Output: fmt.Sprintf("User has answered your questions: %s. You can now continue with the user's answers", strings.Join(parts, ", ")),
		}
	case <-ctx.Done():
		return ToolResult{Output: "Question cancelled", IsError: true}
	}
}
