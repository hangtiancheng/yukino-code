package utils

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// vtControlRe mirrors Node's stripVTControlCharacters pattern. Go regexp
// requires valid UTF-8 patterns, so the C1 introducer uses the \x{9b}
// escape and inputs are normalized with ToValidUTF8 first (raw invalid
// bytes become U+FFFD exactly like JS UTF-8 decoding).
var vtControlRe = regexp.MustCompile(`[\x{1b}\x{9b}][[\]#;?()]*(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\x{7})|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))`)

var crLfRe = regexp.MustCompile(`\r\n?`)

// controlRe matches the Unicode Cc category (C0/C1 controls), mirroring
// the \p{Cc} replacement.
var controlRe = regexp.MustCompile(`\p{Cc}`)

// PlainTerminalText strips ANSI escape sequences and non-printable control
// characters and normalizes line endings, so model/tool text can be embedded
// in plain-text contexts (JSONL logs, the browser UI, single-line summaries).
func PlainTerminalText(text string) string {
	text = strings.ToValidUTF8(text, "\uFFFD")
	text = vtControlRe.ReplaceAllString(text, "")
	text = crLfRe.ReplaceAllString(text, "\n")
	return controlRe.ReplaceAllStringFunc(text, func(character string) string {
		if character == "\n" || character == "\t" {
			return character
		}
		return ""
	})
}

// ContentToText converts message content blocks to a plain-text fallback;
// non-text blocks are reduced to text-only summaries (no base64 payloads).
func ContentToText(content any) string {
	if text, ok := content.(string); ok {
		return text
	}
	blocks, ok := content.([]map[string]any)
	if !ok {
		if generic, ok := content.([]any); ok {
			blocks = nil
			for _, item := range generic {
				if block, ok := item.(map[string]any); ok {
					blocks = append(blocks, block)
				}
			}
		} else {
			return ""
		}
	}
	var parts []string
	for _, block := range blocks {
		blockType, _ := block["type"].(string)
		switch blockType {
		case "text":
			if text, ok := block["text"].(string); ok {
				parts = append(parts, text)
			}
		case "image":
			if source, ok := block["source"].(map[string]any); ok {
				mediaType := "image"
				if source["type"] == "base64" {
					if mt, ok := source["media_type"].(string); ok {
						mediaType = mt
					}
				}
				parts = append(parts, fmt.Sprintf("[Image: %s]", mediaType))
			}
		case "tool_reference":
			if toolName, ok := block["tool_name"].(string); ok {
				parts = append(parts, fmt.Sprintf("[Tool reference: %s]", toolName))
			}
		case "search_result":
			title := "search result"
			if value, ok := block["title"].(string); ok {
				title = value
			}
			source := ""
			if value, ok := block["source"].(string); ok {
				source = " (" + value + ")"
			}
			nested := ""
			if nestedBlocks, ok := block["content"].([]any); ok {
				var records []map[string]any
				for _, item := range nestedBlocks {
					if record, ok := item.(map[string]any); ok {
						records = append(records, record)
					}
				}
				nested = ContentToText(records)
			}
			entry := title + source
			if nested != "" {
				entry += "\n" + nested
			}
			parts = append(parts, entry)
		case "document":
			title := "document"
			if value, ok := block["title"].(string); ok {
				title = value
			}
			parts = append(parts, fmt.Sprintf("[Document: %s]", title))
		}
	}
	return strings.Join(parts, "\n")
}

// IsRecord reports whether the value is a JSON-shaped object.
func IsRecord(value any) bool {
	_, ok := value.(map[string]any)
	return ok
}

// AsRecord coerces a value to a record; arrays become index-keyed maps like
// Object.fromEntries(value.entries()).
func AsRecord(value any) map[string]any {
	if record, ok := value.(map[string]any); ok {
		return record
	}
	if list, ok := value.([]any); ok {
		record := make(map[string]any, len(list))
		for i, item := range list {
			record[strconv.Itoa(i)] = item
		}
		return record
	}
	return map[string]any{}
}

// AsString mirrors String(value).
func AsString(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	return fmt.Sprint(value)
}

// AsErrorString mirrors asErrorString: error messages pass through, other
// values are stringified.
func AsErrorString(value any) string {
	if err, ok := value.(error); ok {
		return err.Error()
	}
	return AsString(value)
}

// IsObject reports whether the value is a non-nil object-shaped value.
func IsObject(value any) bool {
	switch value.(type) {
	case map[string]any, []any:
		return true
	}
	return false
}

// ToFiniteInt applies the shared JSON-number/numeric-string contract: the
// value must be a finite, fully-parsed number, then it is truncated toward
// zero. Partial parses ("12abc"), NaN and Infinity fall back.
func ToFiniteInt(v any) (int, bool) {
	var n float64
	switch value := v.(type) {
	case float64:
		n = value
	case int:
		n = float64(value)
	case int64:
		n = float64(value)
	case string:
		s := strings.TrimSpace(value)
		if !NumericLiteral.MatchString(s) {
			return 0, false
		}
		parsed, err := strconv.ParseFloat(s, 64)
		if err != nil {
			return 0, false
		}
		n = parsed
	default:
		return 0, false
	}
	if math.IsNaN(n) || math.IsInf(n, 0) {
		return 0, false
	}
	return int(math.Trunc(n)), true
}

// IntArg reads an integer tool argument with the finite-int contract.
func IntArg(args map[string]any, key string, fallback int) int {
	if value, ok := ToFiniteInt(args[key]); ok {
		return value
	}
	return fallback
}

// StrArg reads a string tool argument.
func StrArg(args map[string]any, key string, fallback string) string {
	if value, ok := args[key].(string); ok {
		return value
	}
	return fallback
}

// BoolArg reads a boolean tool argument, accepting the reference's string
// and number coercions.
func BoolArg(args map[string]any, key string, fallback bool) bool {
	v := args[key]
	if value, ok := v.(bool); ok {
		return value
	}
	if value, ok := v.(string); ok {
		switch strings.ToLower(strings.TrimSpace(value)) {
		case "true", "1":
			return true
		case "false", "0":
			return false
		}
	}
	switch value := v.(type) {
	case float64:
		if value == 1 {
			return true
		}
		if value == 0 {
			return false
		}
	case int:
		if value == 1 {
			return true
		}
		if value == 0 {
			return false
		}
	}
	return fallback
}

// FormatToolArgs renders the one-line tool argument summary.
func FormatToolArgs(args map[string]any) string {
	if truthy(args["command"]) {
		return StrArg(args, "command", "")
	}
	if truthy(args["file_path"]) {
		return Truncate(StrArg(args, "file_path", ""), ToolArgsSummaryChars)
	}
	if truthy(args["pattern"]) {
		return Truncate(StrArg(args, "pattern", ""), ToolArgsSummaryChars)
	}
	if truthy(args["description"]) {
		return Truncate(StrArg(args, "description", ""), ToolArgsSummaryChars)
	}
	return ""
}

func truthy(value any) bool {
	switch v := value.(type) {
	case nil:
		return false
	case string:
		return v != ""
	case bool:
		return v
	case float64:
		return v != 0
	case int:
		return v != 0
	}
	return true
}

// Truncate shortens a value to max characters, appending an ellipsis.
func Truncate(value string, max int) string {
	runes := []rune(value)
	if len(runes) > max {
		return string(runes[:max]) + "…"
	}
	return value
}
