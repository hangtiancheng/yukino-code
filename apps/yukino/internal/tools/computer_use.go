package tools

import (
	"bytes"
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
	"unicode/utf16"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/yukino-js/yukino/yukino/internal/storage"
)

//go:embed computer_use_assets/*
var computerAssets embed.FS

const (
	ComputerCommandTimeout      = 15 * time.Second
	MaxComputerOutputBytes      = 32 * 1024 * 1024
	MaxScreenshotWidth          = 1366
	MaxScreenshotHeight         = 900
	ComputerBothActionsError    = "Error: send either action (Anthropic-style, one action per call) or actions (OpenAI-style batch), not both."
	ComputerActionRequiredError = "Error: action (Anthropic-style) or actions (OpenAI-style batch) is required."
	ComputerLockedError         = "Error: the computer is being controlled by another Yukino call. Retry after it finishes."
)

type ComputerCommandResult struct {
	Code   int
	Stdout []byte
	Stderr string
}
type ComputerCommandOptions struct {
	Env            map[string]string
	Timeout        time.Duration
	MaxOutputBytes int
}
type ComputerCommandRunner func(context.Context, string, []string, ComputerCommandOptions) (ComputerCommandResult, error)
type ComputerUseOptions struct {
	Environment, Platform string
	RunCommand            ComputerCommandRunner
}
type ComputerUseTool struct {
	platform, environment    string
	run                      ComputerCommandRunner
	scaleX, scaleY           float64
	macHelper, windowsHelper string
}
type computerPoint struct {
	X int `json:"x"`
	Y int `json:"y"`
}
type computerAction struct {
	Type    string          `json:"type"`
	Button  string          `json:"button"`
	X       *int            `json:"x"`
	Y       *int            `json:"y"`
	Keys    []string        `json:"keys"`
	Path    []computerPoint `json:"path"`
	ScrollX *float64        `json:"scrollX"`
	ScrollY *float64        `json:"scrollY"`
	Text    *string         `json:"text"`
}
type computerInput struct {
	Action              string           `json:"action"`
	Actions             []computerAction `json:"actions"`
	PendingSafetyChecks []struct {
		ID string `json:"id"`
	} `json:"pendingSafetyChecks"`
	Status          string          `json:"status"`
	Coordinate      []int           `json:"coordinate"`
	Duration        *float64        `json:"duration"`
	Region          []int           `json:"region"`
	ScrollAmount    *float64        `json:"scroll_amount"`
	ScrollDirection string          `json:"scroll_direction"`
	StartCoordinate []int           `json:"start_coordinate"`
	Text            *string         `json:"text"`
	X               *int            `json:"x"`
	Y               *int            `json:"y"`
	Button          string          `json:"button"`
	Keys            []string        `json:"keys"`
	Path            []computerPoint `json:"path"`
	ScrollX         *float64        `json:"scroll_x"`
	ScrollY         *float64        `json:"scroll_y"`
}
type nativeComputerInput struct {
	Action   string          `json:"action"`
	Button   string          `json:"button,omitempty"`
	Clicks   int             `json:"clicks,omitempty"`
	Duration *float64        `json:"duration,omitempty"`
	Keys     []string        `json:"keys,omitempty"`
	Path     []computerPoint `json:"path,omitempty"`
	ScrollX  *int            `json:"scrollX,omitempty"`
	ScrollY  *int            `json:"scrollY,omitempty"`
	Text     *string         `json:"text,omitempty"`
	X        *int            `json:"x,omitempty"`
	Y        *int            `json:"y,omitempty"`
}

func NewComputerUseTool(options ComputerUseOptions) *ComputerUseTool {
	platform := options.Platform
	if platform == "" {
		platform = runtime.GOOS
	}
	if platform == "windows" {
		platform = "win32"
	}
	environment := options.Environment
	if environment == "" {
		environment = "linux"
		if platform == "darwin" {
			environment = "mac"
		} else if platform == "win32" {
			environment = "windows"
		}
	}
	run := options.RunCommand
	if run == nil {
		run = runComputerCommand
	}
	return &ComputerUseTool{platform: platform, environment: environment, run: run, scaleX: 1, scaleY: 1}
}
func (*ComputerUseTool) Name() string                          { return "ComputerUse" }
func (*ComputerUseTool) Category() ToolCategory                { return CategoryCommand }
func (*ComputerUseTool) IsConcurrencySafe(map[string]any) bool { return false }
func (*ComputerUseTool) ShouldDefer() bool                     { return false }
func (t *ComputerUseTool) Description() string {
	return "Control the current " + t.environment + " computer with screenshots, mouse, keyboard, scrolling, waiting, and zoom. " +
		"Use screenshot before choosing coordinates and verify consequential actions with another screenshot. " +
		"Two call styles are supported: Anthropic-style single actions (action + coordinate/scroll_amount/scroll_direction/start_coordinate/region/text), " +
		"and OpenAI-style batches (actions[] of typed actions with x/y/button/keys/path/scrollX/scrollY/text, plus pendingSafetyChecks and status; " +
		"a screenshot is returned after the batch). Flat OpenAI aliases (action=click/drag/keypress/move) are also accepted."
}
func computerSchema() map[string]any {
	data, _ := computerAssets.ReadFile("computer_use_assets/schema.json")
	var schema map[string]any
	if err := json.Unmarshal(data, &schema); err != nil {
		panic(err)
	}
	return schema
}
func (t *ComputerUseTool) Schema() map[string]any {
	return map[string]any{"name": t.Name(), "description": t.Description(), "input_schema": computerSchema()}
}

var computerValidator = sync.OnceValues(func() (*jsonschema.Schema, error) {
	schema := computerSchema()
	props := schema["properties"].(map[string]any)
	for _, p := range []map[string]any{props, props["actions"].(map[string]any)["items"].(map[string]any)["properties"].(map[string]any)} {
		p["text"].(map[string]any)["maxLength"] = 10000
		p["keys"].(map[string]any)["items"].(map[string]any)["minLength"] = 1
	}
	safety := props["pendingSafetyChecks"].(map[string]any)["items"].(map[string]any)["properties"].(map[string]any)
	safety["id"].(map[string]any)["minLength"] = 1
	compiler := jsonschema.NewCompiler()
	if err := compiler.AddResource("computer.json", schema); err != nil {
		return nil, err
	}
	return compiler.Compile("computer.json")
})

func stripComputerUnknown(value any, schema map[string]any) any {
	if object, ok := value.(map[string]any); ok {
		props, _ := schema["properties"].(map[string]any)
		out := map[string]any{}
		for key, value := range object {
			if sub, ok := props[key].(map[string]any); ok {
				out[key] = stripComputerUnknown(value, sub)
			}
		}
		return out
	}
	if items, ok := value.([]any); ok {
		out := make([]any, len(items))
		sub, _ := schema["items"].(map[string]any)
		for i, item := range items {
			out[i] = stripComputerUnknown(item, sub)
		}
		return out
	}
	return value
}

func (t *ComputerUseTool) Execute(ctx context.Context, args map[string]any) ToolResult {
	fail := func(err error) ToolResult { return ToolResult{Output: "Error: " + err.Error(), IsError: true} }
	raw, err := json.Marshal(args)
	if err != nil {
		return fail(err)
	}
	var value any
	json.Unmarshal(raw, &value)
	value = stripComputerUnknown(value, computerSchema())
	validator, err := computerValidator()
	if err != nil {
		return fail(err)
	}
	if err := validator.Validate(value); err != nil {
		return fail(err)
	}
	raw, _ = json.Marshal(value)
	var input computerInput
	if err := json.Unmarshal(raw, &input); err != nil {
		return fail(err)
	}
	checkText := func(text *string) bool { return text == nil || len(utf16.Encode([]rune(*text))) <= 10000 }
	if !checkText(input.Text) {
		return fail(errors.New("text must contain at most 10000 characters"))
	}
	for _, action := range input.Actions {
		if !checkText(action.Text) {
			return fail(errors.New("text must contain at most 10000 characters"))
		}
	}
	if len(input.Actions) > 0 && input.Action != "" {
		return ToolResult{Output: ComputerBothActionsError, IsError: true}
	}
	if len(input.Actions) == 0 && input.Action == "" {
		return ToolResult{Output: ComputerActionRequiredError, IsError: true}
	}
	release, err := storage.TryAcquireFileSyncLock(filepath.Join(os.TempDir(), "yukino-computer-use"))
	if err != nil {
		return fail(err)
	}
	if release == nil {
		return ToolResult{Output: ComputerLockedError, IsError: true}
	}
	unregister := RegisterExitCleanup(func() { release() })
	defer unregister()
	defer release()
	if err := ctx.Err(); err != nil {
		return fail(err)
	}
	if len(input.Actions) > 0 {
		result, err := t.executeComputerBatch(ctx, input)
		if err != nil {
			return fail(err)
		}
		return result
	}
	result, err := t.runComputerSingle(ctx, input)
	if err != nil {
		return fail(err)
	}
	return result
}

func computerKeys(input computerInput) []string {
	if len(input.Keys) > 0 {
		return input.Keys
	}
	var keys []string
	if input.Text != nil {
		for _, key := range strings.Split(*input.Text, "+") {
			if key = strings.TrimSpace(key); key != "" {
				keys = append(keys, key)
			}
		}
	}
	return keys
}
func computerRequiredPoint(input computerInput) (*int, *int, error) {
	if len(input.Coordinate) == 2 {
		return &input.Coordinate[0], &input.Coordinate[1], nil
	}
	if input.X != nil && input.Y != nil {
		return input.X, input.Y, nil
	}
	return nil, nil, fmt.Errorf("action=%s requires coordinate or x and y.", input.Action)
}
func normalizeComputerAction(input computerInput) (nativeComputerInput, error) {
	a := nativeComputerInput{Action: input.Action}
	switch input.Action {
	case "cursor_position":
	case "type":
		if input.Text == nil {
			return a, errors.New("action=type requires text.")
		}
		a.Text = input.Text
	case "key", "keypress", "hold_key":
		a.Keys = computerKeys(input)
		a.Action = "key"
		if input.Action == "hold_key" {
			a.Action = "hold_key"
			a.Duration = input.Duration
			if len(a.Keys) == 0 || input.Duration == nil {
				return a, errors.New("action=hold_key requires text or keys and duration.")
			}
		} else if len(a.Keys) == 0 {
			return a, fmt.Errorf("action=%s requires text or keys.", input.Action)
		}
	case "mouse_move", "move", "left_click", "right_click", "middle_click", "double_click", "triple_click", "click":
		var err error
		a.X, a.Y, err = computerRequiredPoint(input)
		if err != nil {
			return a, err
		}
		a.Keys = input.Keys
		if input.Action == "mouse_move" || input.Action == "move" {
			a.Action = "mouse_move"
			break
		}
		a.Action = "mouse_click"
		a.Button = "left"
		a.Clicks = 1
		a.Keys = computerKeys(input)
		switch input.Action {
		case "right_click":
			a.Button = "right"
		case "middle_click":
			a.Button = "middle"
		case "double_click":
			a.Clicks = 2
		case "triple_click":
			a.Clicks = 3
		case "click":
			if input.Button != "" {
				a.Button = input.Button
			}
			if a.Button == "wheel" {
				a.Button = "middle"
			}
		}
	case "left_mouse_down", "left_mouse_up":
		a.Keys = input.Keys
	case "left_click_drag":
		if len(input.StartCoordinate) != 2 {
			return a, errors.New("action=left_click_drag requires start_coordinate.")
		}
		x, y, err := computerRequiredPoint(input)
		if err != nil {
			return a, err
		}
		a.Path = []computerPoint{{input.StartCoordinate[0], input.StartCoordinate[1]}, {*x, *y}}
		a.Keys = input.Keys
	case "drag":
		if len(input.Path) == 0 {
			return a, errors.New("action=drag requires a path with at least two points.")
		}
		a.Action = "left_click_drag"
		a.Path = input.Path
		a.Keys = input.Keys
	case "scroll":
		if len(input.Coordinate) == 2 {
			a.X, a.Y = &input.Coordinate[0], &input.Coordinate[1]
		} else if input.X != nil && input.Y != nil {
			a.X, a.Y = input.X, input.Y
		}
		x, y := 0, 0
		if input.ScrollX != nil || input.ScrollY != nil {
			wheel := func(v *float64) int {
				if v == nil || *v == 0 {
					return 0
				}
				n := max(1, int(math.Round(math.Abs(*v)/100)))
				if *v < 0 {
					return -n
				}
				return n
			}
			x, y = wheel(input.ScrollX), wheel(input.ScrollY)
		} else {
			if input.ScrollAmount == nil || input.ScrollDirection == "" {
				return a, errors.New("action=scroll requires scroll_amount and scroll_direction, or scroll_x and scroll_y.")
			}
			n := max(1, int(math.Round(math.Abs(*input.ScrollAmount))))
			switch input.ScrollDirection {
			case "left":
				x = -n
			case "right":
				x = n
			case "up":
				y = -n
			case "down":
				y = n
			}
		}
		a.ScrollX, a.ScrollY = &x, &y
		a.Keys = computerKeys(input)
	default:
		return a, errors.New("action is required.")
	}
	return a, nil
}
func flatComputerAction(item computerAction) computerInput {
	input := computerInput{Action: item.Type, X: item.X, Y: item.Y, Keys: item.Keys}
	switch item.Type {
	case "click":
		input.Button = item.Button
	case "drag":
		input.Path = item.Path
	case "scroll":
		x, y := 0.0, 0.0
		input.ScrollX, input.ScrollY = &x, &y
		if item.ScrollX != nil {
			input.ScrollX = item.ScrollX
		}
		if item.ScrollY != nil {
			input.ScrollY = item.ScrollY
		}
	case "type":
		input.Text = item.Text
	}
	return input
}
func waitComputer(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
func (t *ComputerUseTool) runComputerSingle(ctx context.Context, input computerInput) (ToolResult, error) {
	if input.Action == "screenshot" {
		return t.computerScreenshot(ctx, nil)
	}
	if input.Action == "zoom" {
		if len(input.Region) != 4 || input.Region[2] <= input.Region[0] || input.Region[3] <= input.Region[1] {
			return ToolResult{}, errors.New("action=zoom requires region [x1, y1, x2, y2] with positive area.")
		}
		return t.computerScreenshot(ctx, input.Region)
	}
	if input.Action == "wait" {
		duration := 1.0
		if input.Duration != nil {
			duration = *input.Duration
		}
		if err := waitComputer(ctx, time.Duration(duration*float64(time.Second))); err != nil {
			return ToolResult{}, err
		}
		return ToolResult{Output: "Wait completed."}, nil
	}
	a, err := normalizeComputerAction(input)
	if err != nil {
		return ToolResult{}, err
	}
	if a.X != nil && a.Y != nil {
		x, y := int(math.Floor(float64(*a.X)*t.scaleX+0.5)), int(math.Floor(float64(*a.Y)*t.scaleY+0.5))
		a.X, a.Y = &x, &y
	}
	a.Path = append([]computerPoint(nil), a.Path...)
	for i, p := range a.Path {
		a.Path[i] = computerPoint{int(math.Floor(float64(p.X)*t.scaleX + 0.5)), int(math.Floor(float64(p.Y)*t.scaleY + 0.5))}
	}
	output, err := t.executeComputerNative(ctx, a)
	if err != nil {
		return ToolResult{}, err
	}
	if a.Action == "cursor_position" && output != "" {
		var x, y float64
		if _, err := fmt.Sscanf(output, "%f,%f", &x, &y); err == nil {
			output = fmt.Sprintf("%.0f,%.0f", math.Floor(x/t.scaleX+0.5), math.Floor(y/t.scaleY+0.5))
		}
	}
	if output == "" {
		output = "Computer action " + input.Action + " completed."
	}
	return ToolResult{Output: output}, nil
}
func (t *ComputerUseTool) executeComputerBatch(ctx context.Context, input computerInput) (ToolResult, error) {
	var executed []string
	var screenshot *ToolResult
	for index, item := range input.Actions {
		if err := ctx.Err(); err != nil {
			return ToolResult{}, err
		}
		result, err := t.runComputerSingle(ctx, flatComputerAction(item))
		if err != nil || result.IsError {
			reason := result.Output
			if err != nil {
				reason = err.Error()
			}
			previous := strings.Join(executed, ", ")
			if previous == "" {
				previous = "none"
			}
			return ToolResult{Output: fmt.Sprintf("Error at actions[%d] (%s): %s Actions already executed before the failure (%d): %s.", index, item.Type, reason, len(executed), previous), ContentBlocks: result.ContentBlocks, IsError: true}, nil
		}
		executed = append(executed, item.Type)
		if item.Type == "screenshot" {
			screenshot = &result
		}
	}
	if screenshot == nil {
		result, err := t.computerScreenshot(ctx, nil)
		if err != nil {
			result = ToolResult{Output: "Actions completed, but the follow-up screenshot failed: " + err.Error()}
		}
		screenshot = &result
	}
	var notes []string
	if input.Status != "" {
		notes = append(notes, "Status: "+input.Status+".")
	}
	if len(input.PendingSafetyChecks) > 0 {
		ids := make([]string, len(input.PendingSafetyChecks))
		for i, c := range input.PendingSafetyChecks {
			ids[i] = c.ID
		}
		notes = append(notes, "Acknowledged safety checks: "+strings.Join(ids, ", ")+".")
	}
	output := fmt.Sprintf("%s Executed %d action(s): %s.", screenshot.Output, len(executed), strings.Join(executed, ", "))
	if len(notes) > 0 {
		output += " " + strings.Join(notes, " ")
	}
	return ToolResult{Output: output, ContentBlocks: screenshot.ContentBlocks}, nil
}

func computerAsset(name string) string {
	data, err := computerAssets.ReadFile("computer_use_assets/" + name)
	if err != nil {
		panic(err)
	}
	return string(bytes.Clone(data))
}
