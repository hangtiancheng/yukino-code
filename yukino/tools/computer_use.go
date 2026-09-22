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
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	_ "image/gif"
	_ "image/jpeg"
	"image/png"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/hangtiancheng/yukino-code/yukino/images"
	"github.com/hangtiancheng/yukino-code/yukino/utils"
)

// ComputerUseTool drives the host computer with screenshots, mouse, keyboard,
// scrolling, waiting, and zoom. Ported from the TS reference
// (src/tools/computer-use.ts) with deliberate differences:
//
//   - macOS only. The TS version also supports Windows (PowerShell snippet)
//     and Linux (xdotool); the Go port returns an explicit error on other
//     platforms.
//   - The Swift helper is interpreted with `swift <file>` per invocation
//     instead of being compiled once with xcrun swiftc and cached; the action
//     payload still arrives base64-encoded in YUKINO_COMPUTER_INPUT.
//   - Screenshots are resized with an area-average resampler (stdlib only)
//     instead of sharp, and re-encoded with png.BestCompression (zlib 9)
//     instead of sharp's compressionLevel 8. The coordinate scale is always
//     recomputed from the final encoded dimensions, so the contract survives
//     the different resampler.
//   - Input validation is hand-rolled (no zod); semantic error messages match
//     the TS text verbatim, schema-violation messages are Go-flavored.
//   - The 32MB output cap is enforced per command (stdout+stderr combined)
//     instead of per stream.
//
// The zero value is usable.
type ComputerUseTool struct {
	// Coordinate scale maps the latest screenshot coordinate space back to
	// native screen pixels; updated by screenshot. Zero means 1.
	mu               sync.Mutex
	coordinateScaleX float64
	coordinateScaleY float64
}

const (
	computerCommandTimeout  = 15 * time.Second
	maxComputerOutputBytes  = 32 * 1024 * 1024
	maxScreenshotWidth      = 1366
	maxScreenshotHeight     = 900
	maxComputerBatchActions = 100
	maxComputerTextRunes    = 10_000
)

// computerUseActions mirrors the TS ACTIONS enum (Anthropic-style single
// actions plus flat OpenAI aliases).
var computerUseActions = []string{
	"key", "hold_key", "type", "cursor_position", "mouse_move",
	"left_mouse_down", "left_mouse_up", "left_click", "left_click_drag",
	"right_click", "middle_click", "double_click", "triple_click",
	"scroll", "wait", "screenshot", "zoom", "click", "drag", "keypress", "move",
}

var computerActionSet = func() map[string]bool {
	set := make(map[string]bool, len(computerUseActions))
	for _, a := range computerUseActions {
		set[a] = true
	}
	return set
}()

// openAIComputerActionTypes mirrors the TS OPENAI_ACTION_TYPES enum.
var openAIComputerActionTypes = []string{
	"click", "double_click", "drag", "keypress", "move",
	"screenshot", "scroll", "type", "wait",
}

var openAIComputerActionTypeSet = func() map[string]bool {
	set := make(map[string]bool, len(openAIComputerActionTypes))
	for _, a := range openAIComputerActionTypes {
		set[a] = true
	}
	return set
}()

var (
	computerButtons          = []string{"left", "right", "wheel", "middle", "back", "forward"}
	openAIComputerButtons    = []string{"left", "right", "wheel", "back", "forward"}
	computerScrollDirections = []string{"up", "down", "left", "right"}
	computerStatuses         = []string{"in_progress", "completed", "incomplete"}
)

var computerButtonSet = map[string]bool{
	"left": true, "right": true, "wheel": true, "middle": true, "back": true, "forward": true,
}

var openAIComputerButtonSet = map[string]bool{
	"left": true, "right": true, "wheel": true, "back": true, "forward": true,
}

const computerUseDescriptionTemplate = `Control the current %s computer with screenshots, mouse, keyboard, scrolling, waiting, and zoom. Use screenshot before choosing coordinates and verify consequential actions with another screenshot. Two call styles are supported: Anthropic-style single actions (action + coordinate/scroll_amount/scroll_direction/start_coordinate/region/text), and OpenAI-style batches (actions[] of typed actions with x/y/button/keys/path/scrollX/scrollY/text, plus pendingSafetyChecks and status; a screenshot is returned after the batch). Flat OpenAI aliases (action=click/drag/keypress/move) are also accepted.`

// computerEnvironment mirrors the TS defaultEnvironment mapping.
func computerEnvironment(goos string) string {
	switch goos {
	case "darwin":
		return "mac"
	case "windows":
		return "windows"
	default:
		return "linux"
	}
}

func (t *ComputerUseTool) Name() string { return "ComputerUse" }

func (t *ComputerUseTool) Description() string {
	return fmt.Sprintf(computerUseDescriptionTemplate, computerEnvironment(runtime.GOOS))
}

func (t *ComputerUseTool) Category() ToolCategory { return CategoryCommand }

// IsConcurrencySafe mirrors the TS tool: computer control is never safe to run
// concurrently, regardless of the action (even screenshots mutate the shared
// coordinate-scale state).
func (t *ComputerUseTool) IsConcurrencySafe(map[string]any) bool { return false }

func (t *ComputerUseTool) Schema() map[string]any {
	pathItemSchema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"x": map[string]any{"type": "integer", "minimum": 0},
			"y": map[string]any{"type": "integer", "minimum": 0},
		},
		"required":             []string{"x", "y"},
		"additionalProperties": false,
	}
	coordinateSchema := map[string]any{
		"type":        "array",
		"items":       map[string]any{"type": "integer", "minimum": 0},
		"minItems":    2,
		"maxItems":    2,
		"description": "Anthropic-style [x, y] coordinate in the latest screenshot space.",
	}
	return map[string]any{
		"name":        t.Name(),
		"description": t.Description(),
		"input_schema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"action": map[string]any{
					"type":        "string",
					"enum":        computerUseActions,
					"description": "Anthropic-style single computer action. Send either action or actions, not both.",
				},
				"actions": map[string]any{
					"type": "array",
					"items": map[string]any{
						"type": "object",
						"properties": map[string]any{
							"type": map[string]any{
								"type":        "string",
								"enum":        openAIComputerActionTypes,
								"description": "OpenAI-style action type: click (button, x, y, keys), double_click (x, y, keys), drag (path, keys), keypress (keys), move (x, y, keys), screenshot, scroll (x, y, scrollX, scrollY, keys), type (text), wait.",
							},
							"button": map[string]any{
								"type":        "string",
								"enum":        openAIComputerButtons,
								"description": "Button for type=click.",
							},
							"x": map[string]any{"type": "integer", "minimum": 0},
							"y": map[string]any{"type": "integer", "minimum": 0},
							"keys": map[string]any{
								"type":        "array",
								"items":       map[string]any{"type": "string"},
								"maxItems":    8,
								"description": "Keys held during the action, or pressed by keypress.",
							},
							"path": map[string]any{
								"type":        "array",
								"items":       pathItemSchema,
								"minItems":    2,
								"maxItems":    200,
								"description": "Drag path for type=drag.",
							},
							"scrollX": map[string]any{"type": "number", "description": "Horizontal scroll delta for type=scroll."},
							"scrollY": map[string]any{"type": "number", "description": "Vertical scroll delta for type=scroll."},
							"text":    map[string]any{"type": "string", "description": "Text to type for type=type."},
						},
						"required":             []string{"type"},
						"additionalProperties": false,
					},
					"minItems":    1,
					"maxItems":    maxComputerBatchActions,
					"description": "OpenAI-style ordered batch of computer actions, executed in sequence; a screenshot is returned after the batch.",
				},
				"pendingSafetyChecks": map[string]any{
					"type": "array",
					"items": map[string]any{
						"type": "object",
						"properties": map[string]any{
							"id":      map[string]any{"type": "string"},
							"code":    map[string]any{"type": "string"},
							"message": map[string]any{"type": "string"},
						},
						"required":             []string{"id"},
						"additionalProperties": false,
					},
					"description": "OpenAI-style safety checks raised with the batch; acknowledged in the tool result.",
				},
				"status": map[string]any{
					"type":        "string",
					"enum":        computerStatuses,
					"description": "OpenAI-style status of the computer call; echoed in the tool result.",
				},
				"coordinate": coordinateSchema,
				"duration": map[string]any{
					"type":        "number",
					"minimum":     0,
					"maximum":     60,
					"description": "Seconds for hold_key or wait.",
				},
				"region": map[string]any{
					"type":        "array",
					"items":       map[string]any{"type": "integer", "minimum": 0},
					"minItems":    4,
					"maxItems":    4,
					"description": "Zoom region [x1, y1, x2, y2] in the latest screenshot space.",
				},
				"scroll_amount": map[string]any{
					"type":        "number",
					"description": "Anthropic-style number of wheel clicks to scroll.",
				},
				"scroll_direction": map[string]any{
					"type": "string",
					"enum": computerScrollDirections,
				},
				"start_coordinate": map[string]any{
					"type":        "array",
					"items":       map[string]any{"type": "integer", "minimum": 0},
					"minItems":    2,
					"maxItems":    2,
					"description": "Anthropic-style drag start coordinate.",
				},
				"text": map[string]any{
					"type":        "string",
					"description": "Text to type, or a '+'-separated key combination.",
				},
				"x": map[string]any{"type": "integer", "minimum": 0, "description": "OpenAI-style x coordinate."},
				"y": map[string]any{"type": "integer", "minimum": 0, "description": "OpenAI-style y coordinate."},
				"button": map[string]any{
					"type":        "string",
					"enum":        computerButtons,
					"description": "Button for action=click.",
				},
				"keys": map[string]any{
					"type":        "array",
					"items":       map[string]any{"type": "string"},
					"maxItems":    8,
					"description": "OpenAI-style keys held during an action or pressed by keypress.",
				},
				"path": map[string]any{
					"type":        "array",
					"items":       pathItemSchema,
					"minItems":    2,
					"maxItems":    200,
					"description": "OpenAI-style drag path.",
				},
				"scroll_x": map[string]any{"type": "number", "description": "OpenAI-style horizontal scroll delta."},
				"scroll_y": map[string]any{"type": "number", "description": "OpenAI-style vertical scroll delta."},
			},
			// Either action (Anthropic-style) or actions (OpenAI-style) is
			// required; Execute enforces the mutual exclusivity JSON Schema
			// cannot express.
			"required":             []string{},
			"additionalProperties": false,
		},
	}
}

// computerPathPoint mirrors the TS PathPoint schema.
type computerPathPoint struct {
	x, y int
}

type computerSafetyCheck struct {
	id string
}

// openAIComputerAction is one parsed OpenAI-style batched action.
type openAIComputerAction struct {
	typ        string
	button     string
	hasButton  bool
	x, y       int
	hasX       bool
	hasY       bool
	keys       []string
	path       []computerPathPoint
	scrollX    float64
	scrollY    float64
	hasScrollX bool
	hasScrollY bool
	text       string
	hasText    bool
}

// computerUseInput is the parsed, validated ComputerUse argument bag. Pointer
// fields mirror the TS optionals (nil === undefined).
type computerUseInput struct {
	action              string
	actions             []openAIComputerAction
	pendingSafetyChecks []computerSafetyCheck
	status              string
	coordinate          *[2]int
	duration            *float64
	region              *[4]int
	scrollAmount        *float64
	scrollDirection     string
	startCoordinate     *[2]int
	text                *string
	x                   *int
	y                   *int
	button              string
	keys                []string
	path                []computerPathPoint
	scrollX             *float64
	scrollY             *float64
}

// computerNativeAction is the flat payload shape understood by the platform
// helpers (the TS NativeInput).
type computerNativeAction struct {
	action   string
	button   string
	clicks   int
	duration float64
	keys     []string
	path     []computerPathPoint
	scrollX  int
	scrollY  int
	text     string
	x, y     int
	hasXY    bool
}

// normalizedComputerAction mirrors the TS normalizeAction union: a native
// action, a screenshot, a zoom region, or a wait.
type normalizedComputerAction struct {
	kind     string // "native", "screenshot", "zoom", "wait"
	region   [4]int
	duration float64
	native   computerNativeAction
}

func computerNumberArg(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		// zod's z.number() rejects NaN; infinities fail the integer/range
		// checks downstream, but reject them here too.
		if math.IsNaN(n) || math.IsInf(n, 0) {
			return 0, false
		}
		return n, true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	}
	return 0, false
}

func computerIntArg(v any) (int, bool) {
	f, ok := computerNumberArg(v)
	if !ok || f < 0 || f != math.Trunc(f) || f > math.MaxInt32 {
		return 0, false
	}
	return int(f), true
}

func computerStringListArg(v any, maxItems int, field string) ([]string, error) {
	arr, ok := v.([]any)
	if !ok {
		return nil, fmt.Errorf("%s must be an array of strings", field)
	}
	if len(arr) > maxItems {
		return nil, fmt.Errorf("%s must contain at most %d items", field, maxItems)
	}
	list := make([]string, 0, len(arr))
	for _, item := range arr {
		s, ok := item.(string)
		if !ok || s == "" {
			return nil, fmt.Errorf("%s entries must be non-empty strings", field)
		}
		list = append(list, s)
	}
	return list, nil
}

func computerCoordArg(v any, field string) (*[2]int, error) {
	arr, ok := v.([]any)
	if !ok || len(arr) != 2 {
		return nil, fmt.Errorf("%s must be an array of two non-negative integers", field)
	}
	x, okX := computerIntArg(arr[0])
	y, okY := computerIntArg(arr[1])
	if !okX || !okY {
		return nil, fmt.Errorf("%s must be an array of two non-negative integers", field)
	}
	return &[2]int{x, y}, nil
}

func computerPathArg(v any, field string) ([]computerPathPoint, error) {
	arr, ok := v.([]any)
	if !ok {
		return nil, fmt.Errorf("%s must be an array of points", field)
	}
	if len(arr) < 2 {
		return nil, fmt.Errorf("%s must contain at least two points", field)
	}
	if len(arr) > 200 {
		return nil, fmt.Errorf("%s must contain at most 200 points", field)
	}
	path := make([]computerPathPoint, 0, len(arr))
	for _, item := range arr {
		m, ok := item.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("%s points must be objects with x and y", field)
		}
		xv, xOK := m["x"]
		yv, yOK := m["y"]
		if !xOK || !yOK {
			return nil, fmt.Errorf("%s points must be objects with x and y", field)
		}
		x, okX := computerIntArg(xv)
		y, okY := computerIntArg(yv)
		if !okX || !okY {
			return nil, fmt.Errorf("%s point coordinates must be non-negative integers", field)
		}
		path = append(path, computerPathPoint{x: x, y: y})
	}
	return path, nil
}

func parseOpenAIComputerAction(m map[string]any) (openAIComputerAction, error) {
	var a openAIComputerAction
	typeVal, ok := m["type"]
	if !ok {
		return a, errors.New("type is required")
	}
	s, ok := typeVal.(string)
	if !ok {
		return a, errors.New("type must be a string")
	}
	if !openAIComputerActionTypeSet[s] {
		return a, fmt.Errorf("type %q is not a valid OpenAI-style computer action", s)
	}
	a.typ = s

	if v, ok := m["button"]; ok {
		s, ok := v.(string)
		if !ok || !openAIComputerButtonSet[s] {
			return a, errors.New(`button must be one of "left", "right", "wheel", "back", "forward"`)
		}
		a.button, a.hasButton = s, true
	}
	if v, ok := m["x"]; ok {
		n, ok := computerIntArg(v)
		if !ok {
			return a, errors.New("x must be a non-negative integer")
		}
		a.x, a.hasX = n, true
	}
	if v, ok := m["y"]; ok {
		n, ok := computerIntArg(v)
		if !ok {
			return a, errors.New("y must be a non-negative integer")
		}
		a.y, a.hasY = n, true
	}
	if v, ok := m["keys"]; ok {
		keys, err := computerStringListArg(v, 8, "keys")
		if err != nil {
			return a, err
		}
		a.keys = keys
	}
	if v, ok := m["path"]; ok {
		path, err := computerPathArg(v, "path")
		if err != nil {
			return a, err
		}
		a.path = path
	}
	if v, ok := m["scrollX"]; ok {
		n, ok := computerNumberArg(v)
		if !ok {
			return a, errors.New("scrollX must be a number")
		}
		a.scrollX, a.hasScrollX = n, true
	}
	if v, ok := m["scrollY"]; ok {
		n, ok := computerNumberArg(v)
		if !ok {
			return a, errors.New("scrollY must be a number")
		}
		a.scrollY, a.hasScrollY = n, true
	}
	if v, ok := m["text"]; ok {
		s, ok := v.(string)
		if !ok {
			return a, errors.New("text must be a string")
		}
		if utils.UTF16Len(s) > maxComputerTextRunes {
			return a, fmt.Errorf("text must be at most %d characters", maxComputerTextRunes)
		}
		a.text, a.hasText = s, true
	}
	return a, nil
}

// parseComputerUseInput validates the raw argument bag, mirroring the TS
// ComputerUseInputSchema (zod strips unknown keys, so unknown keys are
// ignored here too).
func parseComputerUseInput(args map[string]any) (*computerUseInput, error) {
	in := &computerUseInput{}

	if v, ok := args["action"]; ok {
		s, ok := v.(string)
		if !ok {
			return nil, errors.New("action must be a string")
		}
		if !computerActionSet[s] {
			return nil, fmt.Errorf("action %q is not a valid computer action", s)
		}
		in.action = s
	}
	if v, ok := args["actions"]; ok {
		arr, ok := v.([]any)
		if !ok {
			return nil, errors.New("actions must be an array")
		}
		if len(arr) == 0 {
			return nil, errors.New("actions must contain at least one action")
		}
		if len(arr) > maxComputerBatchActions {
			return nil, fmt.Errorf("actions must contain at most %d actions", maxComputerBatchActions)
		}
		for i, item := range arr {
			m, ok := item.(map[string]any)
			if !ok {
				return nil, fmt.Errorf("actions[%d] must be an object", i)
			}
			a, err := parseOpenAIComputerAction(m)
			if err != nil {
				return nil, fmt.Errorf("actions[%d]: %s", i, err)
			}
			in.actions = append(in.actions, a)
		}
	}
	if v, ok := args["pendingSafetyChecks"]; ok {
		arr, ok := v.([]any)
		if !ok {
			return nil, errors.New("pendingSafetyChecks must be an array")
		}
		for _, item := range arr {
			m, ok := item.(map[string]any)
			if !ok {
				return nil, errors.New("pendingSafetyChecks entries must be objects")
			}
			id, ok := m["id"].(string)
			if !ok || id == "" {
				return nil, errors.New("pendingSafetyChecks entries require a non-empty id")
			}
			in.pendingSafetyChecks = append(in.pendingSafetyChecks, computerSafetyCheck{id: id})
		}
	}
	if v, ok := args["status"]; ok {
		s, ok := v.(string)
		if !ok || (s != "in_progress" && s != "completed" && s != "incomplete") {
			return nil, errors.New(`status must be one of "in_progress", "completed", "incomplete"`)
		}
		in.status = s
	}
	if v, ok := args["coordinate"]; ok {
		c, err := computerCoordArg(v, "coordinate")
		if err != nil {
			return nil, err
		}
		in.coordinate = c
	}
	if v, ok := args["duration"]; ok {
		d, ok := computerNumberArg(v)
		if !ok || d < 0 || d > 60 {
			return nil, errors.New("duration must be a number between 0 and 60")
		}
		in.duration = &d
	}
	if v, ok := args["region"]; ok {
		arr, ok := v.([]any)
		if !ok || len(arr) != 4 {
			return nil, errors.New("region must be an array of four non-negative integers")
		}
		var region [4]int
		for i := range 4 {
			n, ok := computerIntArg(arr[i])
			if !ok {
				return nil, errors.New("region must be an array of four non-negative integers")
			}
			region[i] = n
		}
		in.region = &region
	}
	if v, ok := args["scroll_amount"]; ok {
		d, ok := computerNumberArg(v)
		if !ok {
			return nil, errors.New("scroll_amount must be a number")
		}
		in.scrollAmount = &d
	}
	if v, ok := args["scroll_direction"]; ok {
		s, ok := v.(string)
		if !ok || (s != "up" && s != "down" && s != "left" && s != "right") {
			return nil, errors.New(`scroll_direction must be one of "up", "down", "left", "right"`)
		}
		in.scrollDirection = s
	}
	if v, ok := args["start_coordinate"]; ok {
		c, err := computerCoordArg(v, "start_coordinate")
		if err != nil {
			return nil, err
		}
		in.startCoordinate = c
	}
	if v, ok := args["text"]; ok {
		s, ok := v.(string)
		if !ok {
			return nil, errors.New("text must be a string")
		}
		if utils.UTF16Len(s) > maxComputerTextRunes {
			return nil, fmt.Errorf("text must be at most %d characters", maxComputerTextRunes)
		}
		in.text = &s
	}
	if v, ok := args["x"]; ok {
		n, ok := computerIntArg(v)
		if !ok {
			return nil, errors.New("x must be a non-negative integer")
		}
		in.x = &n
	}
	if v, ok := args["y"]; ok {
		n, ok := computerIntArg(v)
		if !ok {
			return nil, errors.New("y must be a non-negative integer")
		}
		in.y = &n
	}
	if v, ok := args["button"]; ok {
		s, ok := v.(string)
		if !ok || !computerButtonSet[s] {
			return nil, errors.New(`button must be one of "left", "right", "wheel", "middle", "back", "forward"`)
		}
		in.button = s
	}
	if v, ok := args["keys"]; ok {
		keys, err := computerStringListArg(v, 8, "keys")
		if err != nil {
			return nil, err
		}
		in.keys = keys
	}
	if v, ok := args["path"]; ok {
		path, err := computerPathArg(v, "path")
		if err != nil {
			return nil, err
		}
		in.path = path
	}
	if v, ok := args["scroll_x"]; ok {
		n, ok := computerNumberArg(v)
		if !ok {
			return nil, errors.New("scroll_x must be a number")
		}
		in.scrollX = &n
	}
	if v, ok := args["scroll_y"]; ok {
		n, ok := computerNumberArg(v)
		if !ok {
			return nil, errors.New("scroll_y must be a number")
		}
		in.scrollY = &n
	}
	return in, nil
}

// requiredPoint mirrors the TS requiredPoint helper.
func requiredPoint(in *computerUseInput) (computerPathPoint, error) {
	if in.coordinate != nil {
		return computerPathPoint{x: in.coordinate[0], y: in.coordinate[1]}, nil
	}
	if in.x != nil && in.y != nil {
		return computerPathPoint{x: *in.x, y: *in.y}, nil
	}
	return computerPathPoint{}, fmt.Errorf("action=%s requires coordinate or x and y.", in.action)
}

// keysFor mirrors the TS keysFor helper: explicit keys win, otherwise a
// '+'-separated text is split into a key combination.
func keysFor(in *computerUseInput) []string {
	if len(in.keys) > 0 {
		return in.keys
	}
	if in.text != nil && *in.text != "" {
		var keys []string
		for _, key := range strings.Split(*in.text, "+") {
			key = strings.TrimSpace(key)
			if key != "" {
				keys = append(keys, key)
			}
		}
		return keys
	}
	return nil
}

// toWheelClicks mirrors the TS scroll_x/scroll_y normalization: deltas are
// quantized to wheel clicks, at least one per non-zero delta, per 100px.
func toWheelClicks(value float64) int {
	if value == 0 {
		return 0
	}
	sign := 1
	if value < 0 {
		sign = -1
	}
	return sign * int(math.Max(1, math.Round(math.Abs(value)/100)))
}

func nativeNormalized(n computerNativeAction) *normalizedComputerAction {
	return &normalizedComputerAction{kind: "native", native: n}
}

// normalizeAction maps one validated Anthropic-style input onto the native
// payload union, mirroring the TS normalizeAction including its error text.
func normalizeAction(in *computerUseInput) (*normalizedComputerAction, error) {
	switch in.action {
	case "screenshot":
		return &normalizedComputerAction{kind: "screenshot"}, nil
	case "zoom":
		if in.region == nil || in.region[2] <= in.region[0] || in.region[3] <= in.region[1] {
			return nil, errors.New("action=zoom requires region [x1, y1, x2, y2] with positive area.")
		}
		return &normalizedComputerAction{kind: "zoom", region: *in.region}, nil
	case "wait":
		duration := 1.0
		if in.duration != nil {
			duration = *in.duration
		}
		return &normalizedComputerAction{kind: "wait", duration: duration}, nil
	case "cursor_position":
		return nativeNormalized(computerNativeAction{action: "cursor_position"}), nil
	case "type":
		if in.text == nil {
			return nil, errors.New("action=type requires text.")
		}
		return nativeNormalized(computerNativeAction{action: "type", text: *in.text}), nil
	case "key", "keypress":
		keys := keysFor(in)
		if len(keys) == 0 {
			return nil, fmt.Errorf("action=%s requires text or keys.", in.action)
		}
		return nativeNormalized(computerNativeAction{action: "key", keys: keys}), nil
	case "hold_key":
		keys := keysFor(in)
		if len(keys) == 0 || in.duration == nil {
			return nil, errors.New("action=hold_key requires text or keys and duration.")
		}
		return nativeNormalized(computerNativeAction{action: "hold_key", keys: keys, duration: *in.duration}), nil
	case "mouse_move", "move":
		point, err := requiredPoint(in)
		if err != nil {
			return nil, err
		}
		return nativeNormalized(computerNativeAction{
			action: "mouse_move", x: point.x, y: point.y, hasXY: true, keys: in.keys,
		}), nil
	case "left_mouse_down", "left_mouse_up":
		return nativeNormalized(computerNativeAction{action: in.action, keys: in.keys}), nil
	case "left_click_drag":
		if in.startCoordinate == nil {
			return nil, errors.New("action=left_click_drag requires start_coordinate.")
		}
		end, err := requiredPoint(in)
		if err != nil {
			return nil, err
		}
		return nativeNormalized(computerNativeAction{
			action: "left_click_drag",
			path: []computerPathPoint{
				{x: in.startCoordinate[0], y: in.startCoordinate[1]},
				end,
			},
			keys: in.keys,
		}), nil
	case "drag":
		if in.path == nil {
			return nil, errors.New("action=drag requires a path with at least two points.")
		}
		return nativeNormalized(computerNativeAction{action: "left_click_drag", path: in.path, keys: in.keys}), nil
	case "left_click", "right_click", "middle_click", "double_click", "triple_click", "click":
		point, err := requiredPoint(in)
		if err != nil {
			return nil, err
		}
		var button string
		switch in.action {
		case "right_click":
			button = "right"
		case "middle_click":
			button = "middle"
		case "click":
			if in.button == "wheel" {
				button = "middle"
			} else if in.button != "" {
				button = in.button
			} else {
				button = "left"
			}
		default:
			button = "left"
		}
		clicks := 1
		switch in.action {
		case "double_click":
			clicks = 2
		case "triple_click":
			clicks = 3
		}
		return nativeNormalized(computerNativeAction{
			action: "mouse_click", button: button, clicks: clicks,
			x: point.x, y: point.y, hasXY: true, keys: keysFor(in),
		}), nil
	case "scroll":
		n := computerNativeAction{action: "scroll", keys: keysFor(in)}
		if in.coordinate != nil {
			n.x, n.y, n.hasXY = in.coordinate[0], in.coordinate[1], true
		} else if in.x != nil && in.y != nil {
			n.x, n.y, n.hasXY = *in.x, *in.y, true
		}
		if in.scrollX != nil || in.scrollY != nil {
			scrollX, scrollY := 0.0, 0.0
			if in.scrollX != nil {
				scrollX = *in.scrollX
			}
			if in.scrollY != nil {
				scrollY = *in.scrollY
			}
			n.scrollX = toWheelClicks(scrollX)
			n.scrollY = toWheelClicks(scrollY)
			return nativeNormalized(n), nil
		}
		if in.scrollAmount == nil || in.scrollDirection == "" {
			return nil, errors.New("action=scroll requires scroll_amount and scroll_direction, or scroll_x and scroll_y.")
		}
		amount := int(math.Max(1, math.Round(math.Abs(*in.scrollAmount))))
		switch in.scrollDirection {
		case "left":
			n.scrollX = -amount
		case "right":
			n.scrollX = amount
		case "up":
			n.scrollY = -amount
		case "down":
			n.scrollY = amount
		}
		return nativeNormalized(n), nil
	default:
		return nil, errors.New("action is required.")
	}
}

// openaiActionToFlat maps one OpenAI batched action onto the flat
// Anthropic-style input so both contracts share a single execution path
// (mirrors the TS openaiActionToFlat).
func openaiActionToFlat(item openAIComputerAction) *computerUseInput {
	in := &computerUseInput{keys: item.keys}
	if item.hasX {
		in.x = &item.x
	}
	if item.hasY {
		in.y = &item.y
	}
	switch item.typ {
	case "click":
		in.action = "click"
		if item.hasButton {
			in.button = item.button
		}
	case "double_click":
		in.action = "double_click"
	case "drag":
		in.action = "drag"
		in.path = item.path
	case "keypress":
		in.action = "keypress"
	case "move":
		in.action = "move"
	case "screenshot":
		return &computerUseInput{action: "screenshot"}
	case "scroll":
		in.action = "scroll"
		scrollX, scrollY := 0.0, 0.0
		if item.hasScrollX {
			scrollX = item.scrollX
		}
		if item.hasScrollY {
			scrollY = item.scrollY
		}
		in.scrollX, in.scrollY = &scrollX, &scrollY
	case "type":
		in.action = "type"
		if item.hasText {
			in.text = &item.text
		}
	case "wait":
		in.action = "wait"
	}
	return in
}

func (t *ComputerUseTool) Execute(ctx context.Context, args map[string]any) ToolResult {
	input, err := parseComputerUseInput(args)
	if err != nil {
		return ToolResult{Output: "Error: " + err.Error(), IsError: true}
	}
	if len(input.actions) > 0 && input.action != "" {
		return ToolResult{
			Output:  "Error: send either action (Anthropic-style, one action per call) or actions (OpenAI-style batch), not both.",
			IsError: true,
		}
	}
	if len(input.actions) == 0 && input.action == "" {
		return ToolResult{
			Output:  "Error: action (Anthropic-style) or actions (OpenAI-style batch) is required.",
			IsError: true,
		}
	}

	if err := ctx.Err(); err != nil {
		return ToolResult{Output: "Error: " + err.Error(), IsError: true}
	}
	if len(input.actions) > 0 {
		return t.executeBatch(ctx, input)
	}
	result, err := t.runSingle(ctx, input)
	if err != nil {
		return ToolResult{Output: "Error: " + err.Error(), IsError: true}
	}
	return result
}

// runSingle executes one Anthropic-style action (also the per-item path for
// batches). Mirrors the TS runSingle; errors propagate to the caller, which
// formats them (execute wraps with "Error: ", executeBatch with the
// "Error at actions[i]" prefix).
func (t *ComputerUseTool) runSingle(ctx context.Context, input *computerUseInput) (ToolResult, error) {
	action, err := normalizeAction(input)
	if err != nil {
		return ToolResult{}, err
	}
	switch action.kind {
	case "screenshot":
		return t.screenshot(ctx, nil)
	case "zoom":
		return t.screenshot(ctx, &action.region)
	case "wait":
		wait := time.Duration(action.duration * float64(time.Second))
		select {
		case <-time.After(wait):
		case <-ctx.Done():
			return ToolResult{}, ctx.Err()
		}
		return ToolResult{Output: "Wait completed."}, nil
	}

	native := t.toNativeCoordinates(action.native)
	output, err := t.executeNative(ctx, native)
	if err != nil {
		return ToolResult{}, err
	}
	if native.action == "cursor_position" && output != "" {
		if parts := strings.Split(output, ","); len(parts) == 2 {
			scaleX, scaleY := t.scales()
			x, errX := strconv.ParseFloat(strings.TrimSpace(parts[0]), 64)
			y, errY := strconv.ParseFloat(strings.TrimSpace(parts[1]), 64)
			if errX == nil && errY == nil {
				output = fmt.Sprintf("%d,%d", int(math.Round(x/scaleX)), int(math.Round(y/scaleY)))
			}
		}
	}
	if output == "" {
		name := input.action
		if name == "" {
			name = "batch"
		}
		output = fmt.Sprintf("Computer action %s completed.", name)
	}
	return ToolResult{Output: output}, nil
}

// executeBatch executes an OpenAI-style ordered action batch. Per the OpenAI
// computer output contract, the result always carries the screenshot taken
// after the batch ran, and status / safety checks are echoed so the model can
// continue.
func (t *ComputerUseTool) executeBatch(ctx context.Context, input *computerUseInput) ToolResult {
	var executed []string
	var screenshotResult *ToolResult
	for i, item := range input.actions {
		if err := ctx.Err(); err != nil {
			return ToolResult{Output: "Error: " + err.Error(), IsError: true}
		}
		result, err := t.runSingle(ctx, openaiActionToFlat(item))
		if err != nil {
			return ToolResult{
				Output:  fmt.Sprintf("Error at actions[%d] (%s): %s", i, item.typ, err),
				IsError: true,
			}
		}
		if result.IsError {
			return ToolResult{
				Output:        fmt.Sprintf("Error at actions[%d] (%s): %s", i, item.typ, result.Output),
				ContentBlocks: result.ContentBlocks,
				IsError:       true,
			}
		}
		executed = append(executed, item.typ)
		if item.typ == "screenshot" {
			r := result
			screenshotResult = &r
		}
	}

	if screenshotResult == nil {
		result, err := t.screenshot(ctx, nil)
		if err != nil {
			result = ToolResult{Output: "Actions completed, but the follow-up screenshot failed: " + err.Error()}
		}
		screenshotResult = &result
	}

	var notes []string
	if input.status != "" {
		notes = append(notes, fmt.Sprintf("Status: %s.", input.status))
	}
	if len(input.pendingSafetyChecks) > 0 {
		ids := make([]string, len(input.pendingSafetyChecks))
		for i, check := range input.pendingSafetyChecks {
			ids[i] = check.id
		}
		notes = append(notes, "Acknowledged safety checks: "+strings.Join(ids, ", ")+".")
	}
	suffix := ""
	if len(notes) > 0 {
		suffix = " " + strings.Join(notes, " ")
	}
	return ToolResult{
		Output: fmt.Sprintf("%s Executed %d action(s): %s.%s",
			screenshotResult.Output, len(executed), strings.Join(executed, ", "), suffix),
		ContentBlocks: screenshotResult.ContentBlocks,
	}
}

func (t *ComputerUseTool) scales() (float64, float64) {
	t.mu.Lock()
	defer t.mu.Unlock()
	scaleX, scaleY := t.coordinateScaleX, t.coordinateScaleY
	if scaleX == 0 {
		scaleX = 1
	}
	if scaleY == 0 {
		scaleY = 1
	}
	return scaleX, scaleY
}

func (t *ComputerUseTool) setScales(x, y float64) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.coordinateScaleX, t.coordinateScaleY = x, y
}

// toNativeCoordinates maps screenshot-space coordinates onto native screen
// pixels using the scale recorded by the latest screenshot.
func (t *ComputerUseTool) toNativeCoordinates(action computerNativeAction) computerNativeAction {
	scaleX, scaleY := t.scales()
	scalePoint := func(p computerPathPoint) computerPathPoint {
		return computerPathPoint{
			x: int(math.Round(float64(p.x) * scaleX)),
			y: int(math.Round(float64(p.y) * scaleY)),
		}
	}
	if action.hasXY {
		scaled := scalePoint(computerPathPoint{x: action.x, y: action.y})
		action.x, action.y = scaled.x, scaled.y
	}
	if action.path != nil {
		path := make([]computerPathPoint, len(action.path))
		for i, point := range action.path {
			path[i] = scalePoint(point)
		}
		action.path = path
	}
	return action
}

// computerUsePlatformError is the platform guard: the Go port only supports
// macOS (the TS version also has Windows and Linux backends).
func computerUsePlatformError(goos string) error {
	if goos != "darwin" {
		return fmt.Errorf("ComputerUse is not supported on %s.", goos)
	}
	return nil
}

func (t *ComputerUseTool) executeNative(ctx context.Context, native computerNativeAction) (string, error) {
	if err := computerUsePlatformError(runtime.GOOS); err != nil {
		return "", err
	}
	return t.executeMac(ctx, native)
}

func (t *ComputerUseTool) executeMac(ctx context.Context, native computerNativeAction) (string, error) {
	return t.runMacPayload(ctx, macPayload(native), macPayloadTimeout(native.action, native.duration))
}

// macPayloadTimeout mirrors the TS per-action timeout: hold_key gets its hold
// duration plus 5s slack when that exceeds the default command timeout.
func macPayloadTimeout(action string, duration float64) time.Duration {
	timeout := computerCommandTimeout
	if action == "hold_key" {
		hold := time.Duration(duration*1000+5000) * time.Millisecond
		if hold > timeout {
			timeout = hold
		}
	}
	return timeout
}

// macPayload renders one native action as the JSON object the Swift helper
// reads from YUKINO_COMPUTER_INPUT. Optional fields are omitted when unset,
// mirroring how the TS NativeInput serializes undefined fields.
func macPayload(native computerNativeAction) map[string]any {
	payload := map[string]any{"action": native.action}
	if native.button != "" {
		payload["button"] = native.button
	}
	if native.clicks != 0 {
		payload["clicks"] = native.clicks
	}
	if native.duration != 0 {
		payload["duration"] = native.duration
	}
	if len(native.keys) > 0 {
		payload["keys"] = native.keys
	}
	if len(native.path) > 0 {
		path := make([]map[string]any, len(native.path))
		for i, point := range native.path {
			path[i] = map[string]any{"x": point.x, "y": point.y}
		}
		payload["path"] = path
	}
	if native.scrollX != 0 {
		payload["scrollX"] = native.scrollX
	}
	if native.scrollY != 0 {
		payload["scrollY"] = native.scrollY
	}
	if native.text != "" {
		payload["text"] = native.text
	}
	if native.hasXY {
		payload["x"] = native.x
		payload["y"] = native.y
	}
	return payload
}

// encodeComputerPayload base64-encodes the action JSON for the
// YUKINO_COMPUTER_INPUT environment variable.
func encodeComputerPayload(payload map[string]any) (string, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(raw), nil
}

// runMacPayload writes the Swift helper to a temp file and interprets it with
// `swift <file>`, passing the action payload base64-encoded in
// YUKINO_COMPUTER_INPUT. (The TS version compiles once with xcrun swiftc and
// caches the binary; the Go port interprets per invocation.)
func (t *ComputerUseTool) runMacPayload(ctx context.Context, payload map[string]any, timeout time.Duration) (string, error) {
	encoded, err := encodeComputerPayload(payload)
	if err != nil {
		return "", err
	}
	file, err := os.CreateTemp("", "yukino-computer-helper-*.swift")
	if err != nil {
		return "", err
	}
	helperPath := file.Name()
	defer os.Remove(helperPath)
	if _, err := file.WriteString(macOSSnippet); err != nil {
		file.Close()
		return "", err
	}
	if err := file.Close(); err != nil {
		return "", err
	}

	stdout, stderr, code, err := runComputerCommand(ctx, "swift", []string{helperPath},
		[]string{"YUKINO_COMPUTER_INPUT=" + encoded}, timeout)
	if err != nil {
		return "", err
	}
	if code != 0 {
		return "", computerCommandError("macOS computer helper", code, stdout, stderr)
	}
	return strings.TrimSpace(decodeUTF8Lenient(stdout)), nil
}

// computerCommandError mirrors the TS commandError helper.
func computerCommandError(command string, code int, stdout []byte, stderr string) error {
	detail := strings.TrimSpace(stderr)
	if detail == "" {
		detail = strings.TrimSpace(decodeUTF8Lenient(stdout))
	}
	if detail == "" {
		detail = fmt.Sprintf("exit %d", code)
	}
	return fmt.Errorf("%s failed: %s", command, detail)
}

var errComputerOutputLimit = errors.New("computer command output limit exceeded")

// computerOutputCapture bounds the combined stdout+stderr of one command to
// maxComputerOutputBytes, mirroring the TS runCommand watchdog. exec copies
// the two streams from separate goroutines, hence the mutex.
type computerOutputCapture struct {
	mu     sync.Mutex
	total  int
	limit  int
	capped bool
	stdout bytes.Buffer
	stderr bytes.Buffer
}

func (c *computerOutputCapture) write(target *bytes.Buffer, p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.capped {
		return 0, errComputerOutputLimit
	}
	if c.total+len(p) > c.limit {
		c.capped = true
		return 0, errComputerOutputLimit
	}
	c.total += len(p)
	return target.Write(p)
}

type computerStdoutWriter struct{ capture *computerOutputCapture }

func (w computerStdoutWriter) Write(p []byte) (int, error) {
	return w.capture.write(&w.capture.stdout, p)
}

type computerStderrWriter struct{ capture *computerOutputCapture }

func (w computerStderrWriter) Write(p []byte) (int, error) {
	return w.capture.write(&w.capture.stderr, p)
}

// runComputerCommand mirrors the TS runCommand helper: no shell, bounded
// output, timeout, abort, and a spawn-miss hint. Error messages match the TS
// text.
func runComputerCommand(ctx context.Context, command string, args []string, extraEnv []string, timeout time.Duration) (stdout []byte, stderr string, code int, err error) {
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.CommandContext(runCtx, command, args...)
	if len(extraEnv) > 0 {
		cmd.Env = append(os.Environ(), extraEnv...)
	}
	capture := &computerOutputCapture{limit: maxComputerOutputBytes}
	cmd.Stdout = computerStdoutWriter{capture}
	cmd.Stderr = computerStderrWriter{capture}

	runErr := cmd.Run()
	if runErr == nil {
		// TS: Buffer.concat(stderr).toString("utf8").trim() — WHATWG decoding.
		return capture.stdout.Bytes(), strings.TrimSpace(decodeUTF8Lenient(capture.stderr.Bytes())), 0, nil
	}
	if errors.Is(runErr, errComputerOutputLimit) {
		return nil, "", 0, fmt.Errorf("%s exceeded the %d byte output limit.", command, maxComputerOutputBytes)
	}
	if errors.Is(runErr, exec.ErrNotFound) {
		return nil, "", 0, fmt.Errorf("%s is not installed or not on PATH.", command)
	}
	var exitErr *exec.ExitError
	if errors.As(runErr, &exitErr) {
		if ctx.Err() != nil {
			return nil, "", 0, fmt.Errorf("%s was interrupted.", command)
		}
		if runCtx.Err() == context.DeadlineExceeded {
			return nil, "", 0, fmt.Errorf("%s timed out after %dms.", command, timeout.Milliseconds())
		}
		code := exitErr.ExitCode()
		if code < 0 {
			// TS: the close handler reports `code ?? 1` — a signal-killed
			// child has a null exit code, surfaced as 1.
			code = 1
		}
		return capture.stdout.Bytes(), strings.TrimSpace(decodeUTF8Lenient(capture.stderr.Bytes())), code, nil
	}
	if ctx.Err() != nil {
		return nil, "", 0, fmt.Errorf("%s was interrupted.", command)
	}
	if runCtx.Err() == context.DeadlineExceeded {
		return nil, "", 0, fmt.Errorf("%s timed out after %dms.", command, timeout.Milliseconds())
	}
	return nil, "", 0, runErr
}

// screenshot captures the screen (or a zoom region of it) and returns the
// image tool result, mirroring the TS screenshot method including the
// coordinate-scale bookkeeping.
func (t *ComputerUseTool) screenshot(ctx context.Context, region *[4]int) (ToolResult, error) {
	capture, err := t.captureScreenshot(ctx)
	if err != nil {
		return ToolResult{}, err
	}
	config, _, err := image.DecodeConfig(bytes.NewReader(capture.bytes))
	if err != nil || config.Width <= 0 || config.Height <= 0 {
		return ToolResult{}, errors.New("Unable to determine screenshot dimensions.")
	}
	metaWidth, metaHeight := config.Width, config.Height

	if region != nil {
		scaleX, scaleY := t.scales()
		left := int(math.Round(float64(region[0]) * scaleX))
		top := int(math.Round(float64(region[1]) * scaleY))
		right := int(math.Round(float64(region[2]) * scaleX))
		bottom := int(math.Round(float64(region[3]) * scaleY))
		rawScaleX := float64(metaWidth) / float64(capture.width)
		rawScaleY := float64(metaHeight) / float64(capture.height)
		rawLeft := min(max(0, int(math.Round(float64(left)*rawScaleX))), metaWidth-1)
		rawTop := min(max(0, int(math.Round(float64(top)*rawScaleY))), metaHeight-1)
		rawRight := max(rawLeft+1, min(metaWidth, int(math.Round(float64(right)*rawScaleX))))
		rawBottom := max(rawTop+1, min(metaHeight, int(math.Round(float64(bottom)*rawScaleY))))

		full, _, err := image.Decode(bytes.NewReader(capture.bytes))
		if err != nil {
			return ToolResult{}, err
		}
		cropped := cropImage(full, rawLeft, rawTop, rawRight, rawBottom)
		return t.imageResult(encodePNG(cropped),
			fmt.Sprintf("Zoomed screenshot of [%s].", strings.Join([]string{
				strconv.Itoa(region[0]), strconv.Itoa(region[1]),
				strconv.Itoa(region[2]), strconv.Itoa(region[3]),
			}, ", ")))
	}

	targetScale := math.Min(1, math.Min(
		float64(maxScreenshotWidth)/float64(capture.width),
		float64(maxScreenshotHeight)/float64(capture.height)))
	targetWidth := max(1, int(math.Round(float64(capture.width)*targetScale)))
	targetHeight := max(1, int(math.Round(float64(capture.height)*targetScale)))
	full, _, err := image.Decode(bytes.NewReader(capture.bytes))
	if err != nil {
		return ToolResult{}, err
	}
	normalized := resizeImageArea(full, targetWidth, targetHeight)
	result, err := t.imageResult(encodePNG(normalized),
		fmt.Sprintf("Screenshot %dx%d. Use this coordinate space for subsequent actions.", targetWidth, targetHeight))
	if err != nil {
		return ToolResult{}, err
	}

	// Recompute the coordinate scale from the dimensions that actually came
	// out (the resize pipeline may shrink further than targetScale) so later
	// coordinates land on the right screen pixels.
	if len(result.ContentBlocks) > 0 {
		if source, ok := result.ContentBlocks[0]["source"].(map[string]any); ok {
			if data, ok := source["data"].(string); ok {
				if raw, err := base64.StdEncoding.DecodeString(data); err == nil {
					if final, _, err := image.DecodeConfig(bytes.NewReader(raw)); err == nil &&
						final.Width > 0 && final.Height > 0 {
						t.setScales(float64(capture.width)/float64(final.Width),
							float64(capture.height)/float64(final.Height))
						result.Output = fmt.Sprintf("Screenshot %dx%d. Use this coordinate space for subsequent actions.",
							final.Width, final.Height)
					}
				}
			}
		}
	}
	return result, nil
}

// imageResult compresses the PNG through the shared image pipeline and wraps
// it in an Anthropic-style image content block.
func (t *ComputerUseTool) imageResult(pngBytes []byte, output string) (ToolResult, error) {
	resized, err := images.MaybeResizeAndDownsampleImage(pngBytes, images.MediaTypePNG)
	if err != nil {
		return ToolResult{}, err
	}
	return ToolResult{
		Output: output,
		ContentBlocks: []map[string]any{{
			"type": "image",
			"source": map[string]any{
				"type":       "base64",
				"media_type": string(resized.MediaType),
				"data":       resized.Data,
			},
		}},
	}, nil
}

// screenCapture mirrors the TS captureScreenshot return shape: the raw PNG
// bytes plus the logical screen size (from the Swift screen_size action,
// falling back to the PNG pixel size).
type screenCapture struct {
	bytes         []byte
	width, height int
}

func (t *ComputerUseTool) captureScreenshot(ctx context.Context) (*screenCapture, error) {
	if err := computerUsePlatformError(runtime.GOOS); err != nil {
		return nil, err
	}
	dir, err := os.MkdirTemp("", "yukino-computer-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	screenshotPath := filepath.Join(dir, "screenshot.png")

	stdout, stderr, code, err := runComputerCommand(ctx, "/usr/sbin/screencapture",
		[]string{"-x", "-m", "-t", "png", screenshotPath}, nil, computerCommandTimeout)
	if err != nil {
		return nil, err
	}
	if code != 0 {
		return nil, computerCommandError("screencapture", code, stdout, stderr)
	}

	// The PNG is in device pixels (2x on Retina) while coordinates are
	// logical points; the helper reports the logical size. Failure is not
	// fatal — the metadata fallback below matches the TS .catch(() => "").
	sizeOutput, _ := t.runMacPayload(ctx, map[string]any{"action": "screen_size"}, computerCommandTimeout)
	width, height := 0, 0
	if parts := strings.Split(sizeOutput, ","); len(parts) == 2 {
		if w, errW := strconv.Atoi(strings.TrimSpace(parts[0])); errW == nil {
			width = w
		}
		if h, errH := strconv.Atoi(strings.TrimSpace(parts[1])); errH == nil {
			height = h
		}
	}

	data, err := os.ReadFile(screenshotPath)
	if err != nil {
		return nil, err
	}
	metaWidth, metaHeight := 1, 1
	if config, _, err := image.DecodeConfig(bytes.NewReader(data)); err == nil {
		metaWidth, metaHeight = max(1, config.Width), max(1, config.Height)
	}
	if width <= 0 {
		width = metaWidth
	}
	if height <= 0 {
		height = metaHeight
	}
	return &screenCapture{bytes: data, width: width, height: height}, nil
}

// resizeImageArea downscales src to exactly dstWidth x dstHeight by averaging
// each source rectangle that maps onto a destination pixel (stdlib stand-in
// for sharp's resize).
func resizeImageArea(src image.Image, dstWidth, dstHeight int) image.Image {
	sb := src.Bounds()
	srcWidth, srcHeight := sb.Dx(), sb.Dy()
	if dstWidth <= 0 || dstHeight <= 0 {
		dstWidth, dstHeight = max(1, dstWidth), max(1, dstHeight)
	}
	dst := image.NewRGBA(image.Rect(0, 0, dstWidth, dstHeight))
	for oy := range dstHeight {
		y0 := sb.Min.Y + oy*srcHeight/dstHeight
		y1 := sb.Min.Y + (oy+1)*srcHeight/dstHeight
		if y1 <= y0 {
			y1 = y0 + 1
		}
		for ox := range dstWidth {
			x0 := sb.Min.X + ox*srcWidth/dstWidth
			x1 := sb.Min.X + (ox+1)*srcWidth/dstWidth
			if x1 <= x0 {
				x1 = x0 + 1
			}
			var rSum, gSum, bSum, aSum, n uint64
			for sy := y0; sy < y1 && sy < sb.Max.Y; sy++ {
				for sx := x0; sx < x1 && sx < sb.Max.X; sx++ {
					r, g, b, a := src.At(sx, sy).RGBA()
					rSum += uint64(r)
					gSum += uint64(g)
					bSum += uint64(b)
					aSum += uint64(a)
					n++
				}
			}
			if n == 0 {
				n = 1
			}
			dst.SetRGBA(ox, oy, color.RGBA{
				R: uint8(rSum / n >> 8),
				G: uint8(gSum / n >> 8),
				B: uint8(bSum / n >> 8),
				A: uint8(aSum / n >> 8),
			})
		}
	}
	return dst
}

// cropImage extracts src[left:right, top:bottom] into a fresh image.
func cropImage(src image.Image, left, top, right, bottom int) image.Image {
	dst := image.NewRGBA(image.Rect(0, 0, right-left, bottom-top))
	draw.Draw(dst, dst.Bounds(), src, image.Pt(left, top), draw.Src)
	return dst
}

// encodePNG mirrors sharp's png({compressionLevel: 8}) as closely as the
// stdlib allows (BestCompression).
func encodePNG(img image.Image) []byte {
	var buf bytes.Buffer
	if err := (&png.Encoder{CompressionLevel: png.BestCompression}).Encode(&buf, img); err != nil {
		return nil
	}
	return buf.Bytes()
}
