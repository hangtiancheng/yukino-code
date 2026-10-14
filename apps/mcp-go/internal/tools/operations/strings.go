package operations

import (
	"encoding/base64"
	"strings"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"
)

// UTF16Length counts JavaScript string code units, rather than UTF-8 bytes.
func UTF16Length(s string) int {
	n := 0
	for _, r := range s {
		n++
		if r > 0xffff {
			n++
		}
	}
	return n
}

// UTF16Prefix matches JavaScript slice followed by UTF-8 encoding (SQLite and
// HTTP replace a bisected surrogate pair with the replacement character).
func UTF16Prefix(s string, limit int) string {
	units := utf16.Encode([]rune(s))
	if len(units) > limit {
		units = units[:max(0, limit)]
	}
	return string(utf16.Decode(units))
}

// TrimJS uses ECMAScript's whitespace and line terminator set.
func TrimJS(s string) string {
	return strings.TrimFunc(s, func(r rune) bool {
		return r == '\ufeff' || r == '\t' || r == '\n' || r == '\r' || r == '\v' || r == '\f' || r == '\u2028' || r == '\u2029' || unicode.Is(unicode.Zs, r)
	})
}

// DecodeBase64 follows Node Buffer.from: URL-safe alphabet, optional padding
// and non-alphabet characters are accepted.
func DecodeBase64(s string) []byte {
	s = strings.ReplaceAll(strings.ReplaceAll(s, "-", "+"), "_", "/")
	s = strings.SplitN(s, "=", 2)[0]
	s = strings.Map(func(r rune) rune {
		if r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '+' || r == '/' {
			return r
		}
		return -1
	}, s)
	if len(s)%4 == 1 {
		s = s[:len(s)-1]
	}
	raw, _ := base64.RawStdEncoding.DecodeString(s)
	if raw == nil {
		return []byte{}
	}
	return raw
}

// DecodeUTF8 uses the same replacement boundaries as Node Buffer.toString.
func DecodeUTF8(raw []byte) string {
	var out strings.Builder
	for len(raw) > 0 {
		r, size := utf8.DecodeRune(raw)
		if r != utf8.RuneError || size > 1 {
			out.WriteRune(r)
			raw = raw[size:]
			continue
		}
		width := 1
		b := raw[0]
		switch {
		case b >= 0xc2 && b <= 0xdf:
			width = 2
		case b >= 0xe0 && b <= 0xef:
			width = 3
		case b >= 0xf0 && b <= 0xf4:
			width = 4
		}
		consumed := 1
		for consumed < width && consumed < len(raw) {
			c := raw[consumed]
			if c < 0x80 || c > 0xbf {
				break
			}
			if consumed == 1 && (b == 0xe0 && c < 0xa0 || b == 0xed && c > 0x9f || b == 0xf0 && c < 0x90 || b == 0xf4 && c > 0x8f) {
				break
			}
			consumed++
		}
		out.WriteRune(utf8.RuneError)
		raw = raw[consumed:]
	}
	return out.String()
}
