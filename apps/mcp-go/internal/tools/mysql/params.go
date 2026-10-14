package mysql

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools/operations"
)

// formatSQL follows mysql2's text-query parameter semantics: ? escapes a value,
// ?? escapes an identifier, and arrays expand into SQL lists. It only changes
// placeholders for which a parameter exists and never splits a statement batch.
func formatSQL(query string, params []any) string {
	var output strings.Builder
	index, start := 0, 0
	for i := 0; i < len(query) && index < len(params); {
		if query[i] != '?' {
			i++
			continue
		}
		end := i + 1
		for end < len(query) && query[end] == '?' {
			end++
		}
		if end-i > 2 {
			i = end
			continue
		}
		output.WriteString(query[start:i])
		if end-i == 2 {
			output.WriteString(escapeIDValue(params[index]))
		} else {
			output.WriteString(escapeValue(params[index], false))
		}
		index++
		start, i = end, end
	}
	output.WriteString(query[start:])
	return output.String()
}

func escapeID(value string) string {
	return "`" + strings.ReplaceAll(strings.ReplaceAll(value, "`", "``"), ".", "`.`") + "`"
}

func escapeIDValue(value any) string {
	if array, ok := value.([]any); ok {
		parts := make([]string, len(array))
		for i, item := range array {
			parts[i] = escapeIDValue(item)
		}
		return strings.Join(parts, ", ")
	}
	return escapeID(jsString(value))
}

func escapeValue(value any, stringifyObject bool) string {
	switch item := value.(type) {
	case nil:
		return "NULL"
	case bool:
		return strconv.FormatBool(item)
	case float64:
		return operations.JSONValueToString(item)
	case []any:
		parts := make([]string, len(item))
		for i, entry := range item {
			parts[i] = escapeValue(entry, true)
			if _, nested := entry.([]any); nested {
				parts[i] = "(" + parts[i] + ")"
			}
		}
		return strings.Join(parts, ", ")
	case map[string]any:
		if !stringifyObject {
			// Map order does not affect assignment semantics.
			parts := make([]string, 0, len(item))
			for _, key := range operations.SortedKeys(item) {
				parts = append(parts, "`"+strings.ReplaceAll(key, "`", "``")+"` = "+escapeValue(item[key], true))
			}
			return strings.Join(parts, ", ")
		}
		return quoteString("[object Object]")
	case string:
		return quoteString(item)
	default:
		return fmt.Sprint(item)
	}
}

func jsString(value any) string {
	if value == nil {
		return "null"
	}
	if _, ok := value.(map[string]any); ok {
		return "[object Object]"
	}
	return fmt.Sprint(value)
}

var sqlEscapes = strings.NewReplacer(
	"\x00", "\\0", "\b", "\\b", "\t", "\\t", "\n", "\\n", "\r", "\\r",
	"\x1a", "\\Z", "\"", "\\\"", "'", "\\'", "\\", "\\\\",
)

func quoteString(value string) string { return "'" + sqlEscapes.Replace(value) + "'" }
