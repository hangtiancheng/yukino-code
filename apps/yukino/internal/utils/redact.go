package utils

import (
	"fmt"
	"net/url"
	"os"
	"sort"
	"strings"
)

// EncodeURIComponent mirrors JavaScript's encodeURIComponent: every byte that
// is not an unreserved character is percent-encoded with uppercase hex.
func EncodeURIComponent(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
			c == '-' || c == '_' || c == '.' || c == '!' || c == '~' || c == '*' || c == '\'' || c == '(' || c == ')' {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

// DecodeURIComponent mirrors JavaScript's decodeURIComponent.
func DecodeURIComponent(s string) (string, error) {
	return url.PathUnescape(s)
}

// EnvironmentSecrets returns the environment values whose key names look like
// secrets, each paired with its URI-encoded form.
func EnvironmentSecrets() []string {
	var secrets []string
	for _, entry := range os.Environ() {
		key, value, ok := strings.Cut(entry, "=")
		if !ok || !SensitiveEnvKeyRe.MatchString(key) || value == "" || len(value) <= 3 {
			continue
		}
		secrets = append(secrets, value, EncodeURIComponent(value))
	}
	return secrets
}

// RedactCredentials replaces bearer tokens and known secrets in text.
func RedactCredentials(text string, secrets []string, replacement string) string {
	out := BearerTokenRe.ReplaceAllString(text, "${1}"+replacement)
	filtered := make([]string, 0, len(secrets))
	for _, secret := range secrets {
		if secret != "" {
			filtered = append(filtered, secret)
		}
	}
	sort.SliceStable(filtered, func(i, j int) bool { return len(filtered[i]) > len(filtered[j]) })
	for _, secret := range filtered {
		out = strings.ReplaceAll(out, secret, replacement)
	}
	return out
}
