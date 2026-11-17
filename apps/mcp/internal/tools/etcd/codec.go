package etcd

import (
	"encoding/base64"
	"regexp"
	"unicode/utf8"
)

// etcd's v3 JSON gateway maps proto3 `bytes` fields (keys, range ends and
// values) to base64 strings. These helpers translate between human-friendly
// UTF-8 strings and the wire format. Port of src/tools/etcd/codec.ts.

var bytesFields = map[string]bool{"key": true, "range_end": true, "value": true}

var base64RE = regexp.MustCompile(`^[A-Za-z0-9+/]+={0,2}$`)

// isValidBase64 reports whether text is exactly the standard base64 of some
// byte string.
func isValidBase64(text string) bool {
	if len(text) == 0 || len(text)%4 != 0 {
		return false
	}
	if !base64RE.MatchString(text) {
		return false
	}
	decoded, err := base64.StdEncoding.DecodeString(text)
	if err != nil {
		return false
	}
	return base64.StdEncoding.EncodeToString(decoded) == text
}

// encodeRequestBytes recursively base64-encodes plain UTF-8 strings stored in
// key, range_end and value fields of a request body.
func encodeRequestBytes(body any) any {
	switch v := body.(type) {
	case []any:
		out := make([]any, len(v))
		for i, entry := range v {
			out[i] = encodeRequestBytes(entry)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(v))
		for key, value := range v {
			if bytesFields[key] {
				if s, ok := value.(string); ok {
					out[key] = base64.StdEncoding.EncodeToString([]byte(s))
					continue
				}
			}
			out[key] = encodeRequestBytes(value)
		}
		return out
	default:
		return body
	}
}

// decodeResponseBytes recursively base64-decodes key, range_end and value
// fields of a response back to UTF-8 strings when they decode cleanly. Binary
// values that are not valid UTF-8 stay base64.
func decodeResponseBytes(data any) any {
	switch v := data.(type) {
	case []any:
		out := make([]any, len(v))
		for i, entry := range v {
			out[i] = decodeResponseBytes(entry)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(v))
		for key, value := range v {
			if bytesFields[key] {
				if s, ok := value.(string); ok && isValidBase64(s) {
					if decoded, err := base64.StdEncoding.DecodeString(s); err == nil && utf8.Valid(decoded) {
						out[key] = string(decoded)
						continue
					}
					out[key] = s
					continue
				}
			}
			out[key] = decodeResponseBytes(value)
		}
		return out
	default:
		return data
	}
}
