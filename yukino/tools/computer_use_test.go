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
	"image"
	"image/color"
	"image/png"
	"strings"
	"testing"
	"time"
)

func TestComputerUseToolIdentity(t *testing.T) {
	tool := &ComputerUseTool{}
	if tool.Name() != "ComputerUse" {
		t.Errorf("Name() = %q, want ComputerUse", tool.Name())
	}
	if tool.Category() != CategoryCommand {
		t.Errorf("Category() = %q, want %q", tool.Category(), CategoryCommand)
	}
	if tool.IsConcurrencySafe(map[string]any{"action": "screenshot"}) {
		t.Error("ComputerUse must never be concurrency safe")
	}
	if !strings.Contains(tool.Description(), "computer with screenshots") {
		t.Errorf("unexpected description: %q", tool.Description()[:60])
	}
}

func TestComputerUseSchemaShape(t *testing.T) {
	schema := (&ComputerUseTool{}).Schema()
	if schema["name"] != "ComputerUse" {
		t.Errorf("schema name = %v", schema["name"])
	}
	input := schema["input_schema"].(map[string]any)
	props := input["properties"].(map[string]any)

	action := props["action"].(map[string]any)
	if action["type"] != "string" {
		t.Errorf("action type = %v", action["type"])
	}
	enum, _ := action["enum"].([]string)
	for _, want := range []string{"left_click", "zoom", "click", "drag", "keypress"} {
		found := false
		for _, got := range enum {
			if got == want {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("action enum missing %q", want)
		}
	}

	actions := props["actions"].(map[string]any)
	if actions["type"] != "array" || actions["minItems"] != 1 {
		t.Errorf("actions schema = %v", actions)
	}
	safety := props["pendingSafetyChecks"].(map[string]any)
	if safety["type"] != "array" {
		t.Errorf("pendingSafetyChecks schema = %v", safety)
	}
	status := props["status"].(map[string]any)
	statusEnum, _ := status["enum"].([]string)
	if strings.Join(statusEnum, ",") != "in_progress,completed,incomplete" {
		t.Errorf("status enum = %v", statusEnum)
	}
	required, _ := input["required"].([]string)
	if len(required) != 0 {
		t.Errorf("required = %v, want empty", required)
	}
}

// TestComputerUseExecuteValidation covers argument-validation failures, all of
// which return before any platform command could run. Error text mirrors the
// TS reference.
func TestComputerUseExecuteValidation(t *testing.T) {
	cases := []struct {
		name string
		args map[string]any
		want string
	}{
		{"missing action", map[string]any{}, "action (Anthropic-style) or actions (OpenAI-style batch) is required."},
		{"both call styles", map[string]any{
			"action":  "screenshot",
			"actions": []any{map[string]any{"type": "screenshot"}},
		}, "send either action (Anthropic-style, one action per call) or actions (OpenAI-style batch), not both."},
		{"left_click without coordinate", map[string]any{"action": "left_click"}, "action=left_click requires coordinate or x and y."},
		{"click with only x", map[string]any{"action": "click", "x": 5.0}, "action=click requires coordinate or x and y."},
		{"type without text", map[string]any{"action": "type"}, "action=type requires text."},
		{"key without keys", map[string]any{"action": "key"}, "action=key requires text or keys."},
		{"keypress without keys", map[string]any{"action": "keypress"}, "action=keypress requires text or keys."},
		{"hold_key without duration", map[string]any{"action": "hold_key", "keys": []any{"CMD"}}, "action=hold_key requires text or keys and duration."},
		{"zoom without region", map[string]any{"action": "zoom"}, "action=zoom requires region [x1, y1, x2, y2] with positive area."},
		{"zoom zero-area region", map[string]any{"action": "zoom", "region": []any{1.0, 2.0, 1.0, 5.0}}, "action=zoom requires region [x1, y1, x2, y2] with positive area."},
		{"left_click_drag without start", map[string]any{"action": "left_click_drag", "coordinate": []any{1.0, 2.0}}, "action=left_click_drag requires start_coordinate."},
		{"drag without path", map[string]any{"action": "drag"}, "action=drag requires a path with at least two points."},
		{"scroll without params", map[string]any{"action": "scroll"}, "action=scroll requires scroll_amount and scroll_direction, or scroll_x and scroll_y."},
		{"unknown action", map[string]any{"action": "fly"}, `action "fly" is not a valid computer action`},
		{"bad status", map[string]any{"action": "wait", "status": "done"}, "status must be one of"},
		{"negative coordinate", map[string]any{"action": "left_click", "coordinate": []any{-1.0, 2.0}}, "coordinate must be an array of two non-negative integers"},
		{"fractional coordinate", map[string]any{"action": "left_click", "coordinate": []any{1.5, 2.0}}, "coordinate must be an array of two non-negative integers"},
		{"duration too large", map[string]any{"action": "wait", "duration": 61.0}, "duration must be a number between 0 and 60"},
		{"bad scroll_direction", map[string]any{"action": "scroll", "scroll_amount": 1.0, "scroll_direction": "diagonal"}, "scroll_direction must be one of"},
		{"bad button", map[string]any{"action": "click", "button": "pinky", "x": 1.0, "y": 1.0}, "button must be one of"},
		{"empty batch", map[string]any{"actions": []any{}}, "actions must contain at least one action"},
		{"batch item without type", map[string]any{"actions": []any{map[string]any{"x": 1.0}}}, "actions[0]: type is required"},
		{"batch item bad type", map[string]any{"actions": []any{map[string]any{"type": "fly"}}}, `type "fly" is not a valid OpenAI-style computer action`},
		{"safety check without id", map[string]any{"action": "wait", "pendingSafetyChecks": []any{map[string]any{"code": "x"}}}, "pendingSafetyChecks entries require a non-empty id"},
		{"short path", map[string]any{"action": "drag", "path": []any{map[string]any{"x": 0.0, "y": 0.0}}}, "path must contain at least two points"},
	}
	tool := &ComputerUseTool{}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			result := tool.Execute(context.Background(), tc.args)
			if !result.IsError {
				t.Fatalf("expected error result, got %+v", result)
			}
			if !strings.HasPrefix(result.Output, "Error: ") {
				t.Errorf("output %q lacks Error: prefix", result.Output)
			}
			if !strings.Contains(result.Output, tc.want) {
				t.Errorf("output %q does not contain %q", result.Output, tc.want)
			}
		})
	}
}

func TestComputerUseWaitCompletes(t *testing.T) {
	tool := &ComputerUseTool{}
	result := tool.Execute(context.Background(), map[string]any{"action": "wait", "duration": 0.0})
	if result.IsError || result.Output != "Wait completed." {
		t.Errorf("got %+v, want Wait completed.", result)
	}
}

func TestComputerUseWaitInterrupted(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	result := (&ComputerUseTool{}).Execute(ctx, map[string]any{"action": "wait", "duration": 5.0})
	if !result.IsError {
		t.Errorf("expected interruption error, got %+v", result)
	}
}

func TestComputerUsePlatformGuard(t *testing.T) {
	if err := computerUsePlatformError("darwin"); err != nil {
		t.Errorf("darwin must be supported: %v", err)
	}
	for _, goos := range []string{"linux", "windows"} {
		err := computerUsePlatformError(goos)
		if err == nil || err.Error() != "ComputerUse is not supported on "+goos+"." {
			t.Errorf("%s guard = %v", goos, err)
		}
	}
}

func TestComputerUseNormalizeClickVariants(t *testing.T) {
	cases := []struct {
		name   string
		args   map[string]any
		button string
		clicks int
	}{
		{"left_click", map[string]any{"action": "left_click", "coordinate": []any{1.0, 2.0}}, "left", 1},
		{"right_click", map[string]any{"action": "right_click", "x": 1.0, "y": 2.0}, "right", 1},
		{"middle_click", map[string]any{"action": "middle_click", "x": 1.0, "y": 2.0}, "middle", 1},
		{"double_click", map[string]any{"action": "double_click", "x": 1.0, "y": 2.0}, "left", 2},
		{"triple_click", map[string]any{"action": "triple_click", "x": 1.0, "y": 2.0}, "left", 3},
		{"click default button", map[string]any{"action": "click", "x": 1.0, "y": 2.0}, "left", 1},
		{"click right button", map[string]any{"action": "click", "button": "right", "x": 1.0, "y": 2.0}, "right", 1},
		{"click wheel becomes middle", map[string]any{"action": "click", "button": "wheel", "x": 1.0, "y": 2.0}, "middle", 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			input, err := parseComputerUseInput(tc.args)
			if err != nil {
				t.Fatal(err)
			}
			norm, err := normalizeAction(input)
			if err != nil {
				t.Fatal(err)
			}
			if norm.kind != "native" || norm.native.action != "mouse_click" {
				t.Fatalf("got %+v, want native mouse_click", norm)
			}
			if norm.native.button != tc.button || norm.native.clicks != tc.clicks {
				t.Errorf("button/clicks = %s/%d, want %s/%d", norm.native.button, norm.native.clicks, tc.button, tc.clicks)
			}
			if !norm.native.hasXY || norm.native.x != 1 || norm.native.y != 2 {
				t.Errorf("point = %+v", norm.native)
			}
		})
	}
}

func TestComputerUseNormalizeScroll(t *testing.T) {
	// scroll_amount + direction
	input, err := parseComputerUseInput(map[string]any{
		"action": "scroll", "scroll_amount": 3.0, "scroll_direction": "down", "coordinate": []any{100.0, 200.0},
	})
	if err != nil {
		t.Fatal(err)
	}
	norm, err := normalizeAction(input)
	if err != nil {
		t.Fatal(err)
	}
	if norm.native.scrollX != 0 || norm.native.scrollY != 3 || !norm.native.hasXY || norm.native.x != 100 || norm.native.y != 200 {
		t.Errorf("scroll down native = %+v", norm.native)
	}

	// Fractional amounts round away from zero with a one-click floor.
	input, _ = parseComputerUseInput(map[string]any{"action": "scroll", "scroll_amount": 0.2, "scroll_direction": "up"})
	norm, _ = normalizeAction(input)
	if norm.native.scrollY != -1 {
		t.Errorf("scroll up 0.2 = %+v, want scrollY -1", norm.native)
	}

	// scroll_x / scroll_y quantize to wheel clicks per 100px.
	input, _ = parseComputerUseInput(map[string]any{"action": "scroll", "scroll_x": 250.0, "scroll_y": -40.0})
	norm, _ = normalizeAction(input)
	if norm.native.scrollX != 3 || norm.native.scrollY != -1 || norm.native.hasXY {
		t.Errorf("scroll xy native = %+v", norm.native)
	}
}

func TestToWheelClicks(t *testing.T) {
	cases := []struct {
		value float64
		want  int
	}{
		{0, 0}, {40, 1}, {-40, -1}, {100, 1}, {250, 3}, {-250, -3}, {99, 1}, {150, 2},
	}
	for _, tc := range cases {
		if got := toWheelClicks(tc.value); got != tc.want {
			t.Errorf("toWheelClicks(%v) = %d, want %d", tc.value, got, tc.want)
		}
	}
}

func TestComputerUseKeysFor(t *testing.T) {
	text := "cmd + s"
	in := &computerUseInput{text: &text}
	if got := strings.Join(keysFor(in), ","); got != "cmd,s" {
		t.Errorf("keysFor(text) = %q", got)
	}
	in.keys = []string{"CTRL", "C"}
	if got := strings.Join(keysFor(in), ","); got != "CTRL,C" {
		t.Errorf("keysFor(keys) = %q", got)
	}
	empty := ""
	if got := keysFor(&computerUseInput{text: &empty}); got != nil {
		t.Errorf("keysFor(empty text) = %v", got)
	}
}

func TestComputerUseNormalizeKeysAndType(t *testing.T) {
	input, _ := parseComputerUseInput(map[string]any{"action": "key", "text": "cmd+s"})
	norm, err := normalizeAction(input)
	if err != nil || norm.native.action != "key" || strings.Join(norm.native.keys, ",") != "cmd,s" {
		t.Errorf("key from text: %+v err=%v", norm, err)
	}

	input, _ = parseComputerUseInput(map[string]any{"action": "hold_key", "keys": []any{"SHIFT"}, "duration": 2.0})
	norm, err = normalizeAction(input)
	if err != nil || norm.native.action != "hold_key" || norm.native.duration != 2 {
		t.Errorf("hold_key: %+v err=%v", norm, err)
	}

	input, _ = parseComputerUseInput(map[string]any{"action": "type", "text": "hello world"})
	norm, err = normalizeAction(input)
	if err != nil || norm.native.action != "type" || norm.native.text != "hello world" {
		t.Errorf("type: %+v err=%v", norm, err)
	}

	input, _ = parseComputerUseInput(map[string]any{"action": "cursor_position"})
	norm, err = normalizeAction(input)
	if err != nil || norm.native.action != "cursor_position" {
		t.Errorf("cursor_position: %+v err=%v", norm, err)
	}

	// wait defaults to one second.
	input, _ = parseComputerUseInput(map[string]any{"action": "wait"})
	norm, err = normalizeAction(input)
	if err != nil || norm.kind != "wait" || norm.duration != 1 {
		t.Errorf("wait default: %+v err=%v", norm, err)
	}
}

func TestComputerUseNormalizeDrag(t *testing.T) {
	input, _ := parseComputerUseInput(map[string]any{
		"action":           "left_click_drag",
		"start_coordinate": []any{10.0, 20.0},
		"coordinate":       []any{30.0, 40.0},
	})
	norm, err := normalizeAction(input)
	if err != nil {
		t.Fatal(err)
	}
	if norm.native.action != "left_click_drag" || len(norm.native.path) != 2 ||
		norm.native.path[0] != (computerPathPoint{x: 10, y: 20}) ||
		norm.native.path[1] != (computerPathPoint{x: 30, y: 40}) {
		t.Errorf("left_click_drag native = %+v", norm.native)
	}

	input, _ = parseComputerUseInput(map[string]any{"action": "drag", "path": []any{
		map[string]any{"x": 0.0, "y": 0.0},
		map[string]any{"x": 5.0, "y": 5.0},
		map[string]any{"x": 10.0, "y": 1.0},
	}})
	norm, err = normalizeAction(input)
	if err != nil || norm.native.action != "left_click_drag" || len(norm.native.path) != 3 {
		t.Errorf("drag native = %+v err=%v", norm, err)
	}
}

func TestOpenAIActionToFlat(t *testing.T) {
	// scroll defaults missing deltas to zero and always takes the scroll_x/y path.
	flat := openaiActionToFlat(openAIComputerAction{typ: "scroll", hasX: true, x: 7, hasY: true, y: 9})
	if flat.action != "scroll" || flat.scrollX == nil || *flat.scrollX != 0 || flat.scrollY == nil || *flat.scrollY != 0 {
		t.Errorf("scroll flat = %+v", flat)
	}
	if flat.x == nil || *flat.x != 7 || flat.y == nil || *flat.y != 9 {
		t.Errorf("scroll flat point = %+v", flat)
	}

	// type without text must fail normalization like the TS port.
	flat = openaiActionToFlat(openAIComputerAction{typ: "type"})
	if _, err := normalizeAction(flat); err == nil || err.Error() != "action=type requires text." {
		t.Errorf("type without text err = %v", err)
	}

	// click keeps the button only when present.
	flat = openaiActionToFlat(openAIComputerAction{typ: "click", button: "right", hasButton: true, hasX: true, x: 1, hasY: true, y: 2})
	if flat.action != "click" || flat.button != "right" {
		t.Errorf("click flat = %+v", flat)
	}

	// screenshot drops coordinates and keys.
	flat = openaiActionToFlat(openAIComputerAction{typ: "screenshot", keys: []string{"CTRL"}, hasX: true, x: 1})
	if flat.action != "screenshot" || flat.keys != nil || flat.x != nil {
		t.Errorf("screenshot flat = %+v", flat)
	}

	// wait carries no duration (normalize defaults it to 1s).
	flat = openaiActionToFlat(openAIComputerAction{typ: "wait"})
	norm, err := normalizeAction(flat)
	if err != nil || norm.kind != "wait" || norm.duration != 1 {
		t.Errorf("wait flat = %+v err=%v", norm, err)
	}
}

func TestComputerUseBatchStopsAtFirstError(t *testing.T) {
	result := (&ComputerUseTool{}).Execute(context.Background(), map[string]any{
		"actions": []any{
			map[string]any{"type": "click"},
			map[string]any{"type": "screenshot"},
		},
	})
	if !result.IsError {
		t.Fatalf("expected error, got %+v", result)
	}
	want := "Error at actions[0] (click): action=click requires coordinate or x and y."
	if result.Output != want {
		t.Errorf("output = %q, want %q", result.Output, want)
	}
}

func TestMacPayloadConstruction(t *testing.T) {
	input, err := parseComputerUseInput(map[string]any{
		"action": "click", "button": "right", "x": 20.0, "y": 30.0,
	})
	if err != nil {
		t.Fatal(err)
	}
	norm, err := normalizeAction(input)
	if err != nil {
		t.Fatal(err)
	}
	payload := macPayload(norm.native)

	encoded, err := encodeComputerPayload(payload)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatalf("payload is not valid base64: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("payload is not valid JSON: %v", err)
	}
	if decoded["action"] != "mouse_click" || decoded["button"] != "right" {
		t.Errorf("decoded = %v", decoded)
	}
	if decoded["clicks"] != float64(1) || decoded["x"] != float64(20) || decoded["y"] != float64(30) {
		t.Errorf("decoded = %v", decoded)
	}
	for _, absent := range []string{"keys", "path", "text", "duration", "scrollX", "scrollY"} {
		if _, ok := decoded[absent]; ok {
			t.Errorf("payload unexpectedly carries %q", absent)
		}
	}
}

func TestMacPayloadOmitsUnsetCoordinates(t *testing.T) {
	// cursor_position and key presses carry no x/y, matching the TS
	// NativeInput serialization.
	payload := macPayload(computerNativeAction{action: "cursor_position"})
	if _, ok := payload["x"]; ok {
		t.Error("cursor_position payload must not carry x")
	}
	payload = macPayload(computerNativeAction{action: "key", keys: []string{"CMD", "S"}})
	if _, ok := payload["x"]; ok {
		t.Error("key payload must not carry x")
	}
	if keys, _ := payload["keys"].([]string); strings.Join(keys, ",") != "CMD,S" {
		t.Errorf("keys = %v", payload["keys"])
	}
}

func TestMacPayloadDragPath(t *testing.T) {
	payload := macPayload(computerNativeAction{
		action: "left_click_drag",
		path:   []computerPathPoint{{x: 0, y: 0}, {x: 5, y: 5}},
	})
	path, ok := payload["path"].([]map[string]any)
	if !ok || len(path) != 2 || path[1]["x"] != 5 || path[1]["y"] != 5 {
		t.Errorf("path = %v", payload["path"])
	}
}

func TestMacPayloadTimeout(t *testing.T) {
	if got := macPayloadTimeout("key", 0); got != computerCommandTimeout {
		t.Errorf("key timeout = %v", got)
	}
	if got := macPayloadTimeout("hold_key", 2); got != computerCommandTimeout {
		t.Errorf("short hold timeout = %v", got)
	}
	if got := macPayloadTimeout("hold_key", 20); got != 25*time.Second {
		t.Errorf("long hold timeout = %v, want 25s", got)
	}
}

// TestComputerUseCoordinateScaling mirrors the TS test: a 2000x1000 capture
// normalized to 1366x683 sets scale 2000/1366 x 1000/683, and coordinate
// [683, 342] maps back to native (1000, 501).
func TestComputerUseCoordinateScaling(t *testing.T) {
	tool := &ComputerUseTool{}
	if sx, sy := tool.scales(); sx != 1 || sy != 1 {
		t.Fatalf("zero-value scales = %v/%v, want 1/1", sx, sy)
	}
	tool.setScales(2000.0/1366.0, 1000.0/683.0)

	native := tool.toNativeCoordinates(computerNativeAction{
		action: "mouse_move", x: 683, y: 342, hasXY: true,
	})
	if native.x != 1000 || native.y != 501 {
		t.Errorf("scaled point = (%d, %d), want (1000, 501)", native.x, native.y)
	}

	native = tool.toNativeCoordinates(computerNativeAction{
		action: "left_click_drag",
		path:   []computerPathPoint{{x: 683, y: 342}, {x: 0, y: 0}},
	})
	if native.path[0].x != 1000 || native.path[0].y != 501 || native.path[1].x != 0 {
		t.Errorf("scaled path = %v", native.path)
	}
}

func TestComputerUseCommandError(t *testing.T) {
	if got := computerCommandError("swiftc", 1, []byte("out"), "boom").Error(); got != "swiftc failed: boom" {
		t.Errorf("stderr preference: %q", got)
	}
	if got := computerCommandError("swiftc", 1, []byte("  out  "), "").Error(); got != "swiftc failed: out" {
		t.Errorf("stdout fallback: %q", got)
	}
	if got := computerCommandError("swiftc", 3, nil, "").Error(); got != "swiftc failed: exit 3" {
		t.Errorf("exit fallback: %q", got)
	}
}

func testPNG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			img.SetRGBA(x, y, color.RGBA{R: uint8(x % 256), G: uint8(y % 256), B: 128, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestComputerUseImageResult(t *testing.T) {
	tool := &ComputerUseTool{}
	result, err := tool.imageResult(testPNG(t, 64, 48), "Screenshot 64x48.")
	if err != nil {
		t.Fatal(err)
	}
	if result.IsError || result.Output != "Screenshot 64x48." {
		t.Errorf("result = %+v", result)
	}
	if len(result.ContentBlocks) != 1 {
		t.Fatalf("content blocks = %d", len(result.ContentBlocks))
	}
	block := result.ContentBlocks[0]
	if block["type"] != "image" {
		t.Fatalf("block type = %v", block["type"])
	}
	source, _ := block["source"].(map[string]any)
	if source["type"] != "base64" || source["media_type"] != "image/png" {
		t.Fatalf("source = %v", source)
	}
	data, _ := source["data"].(string)
	raw, err := base64.StdEncoding.DecodeString(data)
	if err != nil {
		t.Fatal(err)
	}
	config, _, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil || config.Width != 64 || config.Height != 48 {
		t.Errorf("decoded config = %+v err=%v", config, err)
	}
}

func TestResizeImageArea(t *testing.T) {
	src := image.NewRGBA(image.Rect(0, 0, 100, 50))
	for i := range src.Pix {
		src.Pix[i] = 255
	}
	dst := resizeImageArea(src, 50, 25)
	bounds := dst.Bounds()
	if bounds.Dx() != 50 || bounds.Dy() != 25 {
		t.Fatalf("resized bounds = %v", bounds)
	}
	// Averaging solid white stays white.
	r, g, b, a := dst.At(10, 10).RGBA()
	if r>>8 != 255 || g>>8 != 255 || b>>8 != 255 || a>>8 != 255 {
		t.Errorf("averaged pixel = %d,%d,%d,%d", r>>8, g>>8, b>>8, a>>8)
	}

	// Identity resize keeps dimensions.
	same := resizeImageArea(src, 100, 50)
	if same.Bounds().Dx() != 100 || same.Bounds().Dy() != 50 {
		t.Errorf("identity resize bounds = %v", same.Bounds())
	}
}

func TestCropImage(t *testing.T) {
	src := image.NewRGBA(image.Rect(0, 0, 10, 10))
	src.SetRGBA(3, 4, color.RGBA{R: 9, G: 8, B: 7, A: 255})
	cropped := cropImage(src, 2, 3, 6, 8)
	bounds := cropped.Bounds()
	if bounds.Dx() != 4 || bounds.Dy() != 5 {
		t.Fatalf("crop bounds = %v", bounds)
	}
	pixel := cropped.At(1, 1) // source (3, 4)
	r, g, b, _ := pixel.RGBA()
	if r>>8 != 9 || g>>8 != 8 || b>>8 != 7 {
		t.Errorf("crop pixel = %d,%d,%d", r>>8, g>>8, b>>8)
	}
}

func TestComputerEnvironment(t *testing.T) {
	cases := map[string]string{"darwin": "mac", "windows": "windows", "linux": "linux", "freebsd": "linux"}
	for goos, want := range cases {
		if got := computerEnvironment(goos); got != want {
			t.Errorf("computerEnvironment(%s) = %s, want %s", goos, got, want)
		}
	}
}
