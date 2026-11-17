package llm

import (
	"encoding/base64"
	"encoding/json"

	"github.com/yukino-js/yukino/yukino/internal/conversation"
)

func computerCallArguments(item map[string]any) map[string]any {
	raw, ok := item["actions"].([]any)
	if !ok {
		if action, ok := item["action"].(map[string]any); ok {
			raw = []any{action}
		}
	}
	actions := []any{}
	for _, value := range raw {
		action, ok := value.(map[string]any)
		if !ok {
			continue
		}
		copy := map[string]any{}
		for key, value := range action {
			copy[key] = value
		}
		kind, _ := action["type"].(string)
		if kind == "scroll" {
			copy = map[string]any{"type": "scroll", "x": action["x"], "y": action["y"], "scrollX": action["scroll_x"], "scrollY": action["scroll_y"]}
		}
		if kind == "scroll" || kind == "click" || kind == "double_click" || kind == "drag" || kind == "move" {
			keys, _ := action["keys"].([]any)
			delete(copy, "keys")
			if len(keys) > 0 {
				copy["keys"] = keys
			}
		}
		actions = append(actions, copy)
	}
	checks := []any{}
	if raw, ok := item["pending_safety_checks"].([]any); ok {
		for _, value := range raw {
			if check, ok := value.(map[string]any); ok {
				copy := map[string]any{"id": check["id"]}
				for _, key := range []string{"code", "message"} {
					if text, ok := check[key].(string); ok && text != "" {
						copy[key] = text
					}
				}
				checks = append(checks, copy)
			}
		}
	}
	return map[string]any{"actions": actions, "pendingSafetyChecks": checks, "status": item["status"]}
}

func computerActionsForResponses(args map[string]any) []map[string]any {
	encoded, _ := json.Marshal(args["actions"])
	var raw []map[string]any
	if json.Unmarshal(encoded, &raw) != nil {
		return []map[string]any{}
	}
	actions := []map[string]any{}
	for _, item := range raw {
		kind, _ := item["type"].(string)
		action := map[string]any{"type": kind}
		valid := true
		point := func(value map[string]any) bool {
			_, x := value["x"].(float64)
			_, y := value["y"].(float64)
			return x && y
		}
		if kind == "click" || kind == "double_click" || kind == "move" || kind == "scroll" {
			if !point(item) {
				continue
			}
			action["x"], action["y"] = item["x"], item["y"]
		}
		switch kind {
		case "click":
			button, exists := item["button"]
			if !exists {
				button = "left"
			}
			switch button {
			case "left", "right", "wheel", "back", "forward":
				action["button"] = button
			default:
				valid = false
			}
		case "double_click":
			action["keys"] = nil
		case "drag":
			path, ok := item["path"].([]any)
			if !ok {
				valid = false
				break
			}
			points := []map[string]any{}
			for _, value := range path {
				p, ok := value.(map[string]any)
				if !ok || !point(p) {
					valid = false
					break
				}
				points = append(points, map[string]any{"x": p["x"], "y": p["y"]})
			}
			action["path"] = points
		case "keypress":
			keys, ok := item["keys"].([]any)
			if !ok {
				valid = false
			} else {
				for _, key := range keys {
					if _, ok := key.(string); !ok {
						valid = false
					}
				}
				action["keys"] = keys
			}
		case "move", "screenshot", "wait":
		case "scroll":
			for from, to := range map[string]string{"scrollX": "scroll_x", "scrollY": "scroll_y"} {
				value, exists := item[from]
				if !exists {
					value = float64(0)
				}
				if _, ok := value.(float64); !ok {
					valid = false
				}
				action[to] = value
			}
		case "type":
			if text, ok := item["text"].(string); ok {
				action["text"] = text
			} else {
				valid = false
			}
		default:
			valid = false
		}
		if kind == "click" || kind == "double_click" || kind == "move" || kind == "scroll" || kind == "drag" {
			if keys, exists := item["keys"]; exists {
				if keys == nil {
					action["keys"] = nil
				} else if array, ok := keys.([]any); ok {
					for _, key := range array {
						if _, ok := key.(string); !ok {
							valid = false
						}
					}
					action["keys"] = array
				} else {
					valid = false
				}
			}
		}
		if valid {
			actions = append(actions, action)
		}
	}
	return actions
}
func safetyChecksForResponses(args map[string]any) []map[string]any {
	encoded, _ := json.Marshal(args["pendingSafetyChecks"])
	var raw []any
	json.Unmarshal(encoded, &raw)
	checks := []map[string]any{}
	for _, value := range raw {
		check, ok := value.(map[string]any)
		if !ok {
			continue
		}
		id, ok := check["id"].(string)
		if !ok {
			continue
		}
		copy := map[string]any{"id": id}
		for _, key := range []string{"code", "message"} {
			if text, ok := check[key].(string); ok {
				copy[key] = text
			}
		}
		checks = append(checks, copy)
	}
	return checks
}
func computerScreenshotURL(result conversation.ToolResultBlock) string {
	for _, block := range result.ContentBlocks {
		if url := imageDataURL(block); url != "" {
			return url
		}
	}
	return ""
}
func documentForResponses(block map[string]any) map[string]any {
	if block["type"] != "document" {
		return nil
	}
	source, ok := block["source"].(map[string]any)
	if !ok {
		return nil
	}
	title, _ := block["title"].(string)
	if title == "" {
		title = "tool-result"
	}
	data, _ := source["data"].(string)
	switch source["type"] {
	case "url":
		if url, ok := source["url"].(string); ok && url != "" {
			return map[string]any{"type": "input_file", "file_url": url}
		}
	case "base64":
		if data != "" {
			return map[string]any{"type": "input_file", "file_data": data, "filename": title + ".pdf"}
		}
	case "text":
		if data != "" {
			return map[string]any{"type": "input_file", "file_data": base64.StdEncoding.EncodeToString([]byte(data)), "filename": title + ".txt"}
		}
	}
	return nil
}
