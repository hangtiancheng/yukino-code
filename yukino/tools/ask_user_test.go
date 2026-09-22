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
	"testing"
)

// newAskingTool wires an AskUserQuestionTool whose asker answers every
// question with a fixed reply.
func newAskingTool(reply func(q Question) string) (*AskUserQuestionTool, chan AskUserRequest) {
	requestCh := make(chan AskUserRequest, 1)
	go func() {
		req := <-requestCh
		answers := make(map[string]string, len(req.Questions))
		for _, q := range req.Questions {
			answers[q.Text] = reply(q)
		}
		req.ResponseCh <- QuestionResponse{Answers: answers}
	}()
	return &AskUserQuestionTool{RequestCh: requestCh}, requestCh
}

// TS embeds the raw question/answer texts in a template literal
// (ask-user.ts:177): `"q" = "a"` with no escaping — embedded quotes appear
// verbatim, unlike Go %q quoting.
func TestAskUserAnswerFormattingIsRaw(t *testing.T) {
	tool, _ := newAskingTool(func(q Question) string {
		return `say "hi"`
	})
	res := tool.Execute(context.Background(), map[string]any{
		"questions": []any{
			map[string]any{
				"question":    `Pick "one"`,
				"header":      "Pick",
				"options":     []any{map[string]any{"label": "a"}, map[string]any{"label": "b"}},
				"multiSelect": false,
			},
		},
	})
	if res.IsError {
		t.Fatalf("unexpected error: %s", res.Output)
	}
	want := `User has answered your questions: "Pick "one"" = "say "hi"". You can now continue with the user's answers`
	if res.Output != want {
		t.Errorf("output =\n%q\nwant\n%q", res.Output, want)
	}
}

// zod rejects a present non-string description (z.string().optional()).
func TestAskUserRejectsNonStringDescription(t *testing.T) {
	tool, _ := newAskingTool(func(q Question) string { return "x" })
	res := tool.Execute(context.Background(), map[string]any{
		"questions": []any{
			map[string]any{
				"question":    "q",
				"header":      "h",
				"options":     []any{map[string]any{"label": "a", "description": 3}, map[string]any{"label": "b"}},
				"multiSelect": false,
			},
		},
	})
	if !res.IsError {
		t.Errorf("non-string description must be rejected, got %#v", res)
	}
}

// Answers are rendered in question order (TS Object.entries follows the
// dialog's construction order; Go map order is random).
func TestAskUserAnswersInQuestionOrder(t *testing.T) {
	tool, _ := newAskingTool(func(q Question) string { return q.Header })
	res := tool.Execute(context.Background(), map[string]any{
		"questions": []any{
			map[string]any{"question": "first", "header": "H1", "options": []any{map[string]any{"label": "a"}, map[string]any{"label": "b"}}, "multiSelect": false},
			map[string]any{"question": "second", "header": "H2", "options": []any{map[string]any{"label": "a"}, map[string]any{"label": "b"}}, "multiSelect": true},
		},
	})
	if res.IsError {
		t.Fatalf("unexpected error: %s", res.Output)
	}
	want := `User has answered your questions: "first" = "H1", "second" = "H2". You can now continue with the user's answers`
	if res.Output != want {
		t.Errorf("output =\n%q\nwant\n%q", res.Output, want)
	}
}
