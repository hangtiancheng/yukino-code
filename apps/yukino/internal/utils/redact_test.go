package utils

import (
	"os"
	"testing"
)

// Expected outputs byte-verified against src/utils/redact.ts via npx tsx.
func TestRedactCredentials(t *testing.T) {
	cases := []struct {
		text        string
		secrets     []string
		replacement string
		want        string
	}{
		{"Authorization: Bearer abc123token", nil, "<redacted>", "Authorization: Bearer <redacted>"},
		{"bearer   xyz", nil, "<redacted>", "bearer   <redacted>"},
		{"no token here", nil, "<redacted>", "no token here"},
		{"key=sk-secret-12345", []string{"sk-secret-12345"}, "<redacted>", "key=<redacted>"},
		{"abcdef", []string{"abc", "abcdef"}, "<redacted>", "<redacted>"},
		{"abcdef", []string{"abcdef", "abc"}, "<redacted>", "<redacted>"},
		{"a+b=c d", []string{"a+b", "c d"}, "[redacted]", "[redacted]=[redacted]"},
		{"Bearer tok Bearer tok2", nil, "[redacted]", "Bearer [redacted] Bearer [redacted]"},
		{"", []string{"x"}, "<redacted>", ""},
		{"plain", []string{"", "  "}, "<redacted>", "plain"},
		{`curl -H "Authorization: Bearer sk-ant-abc123" https://x.dev`, []string{"sk-ant-abc123"}, "[redacted]", `curl -H "Authorization: Bearer [redacted]" https://x.dev`},
	}
	for _, c := range cases {
		if got := RedactCredentials(c.text, c.secrets, c.replacement); got != c.want {
			t.Errorf("RedactCredentials(%q, %v, %q) = %q, want %q", c.text, c.secrets, c.replacement, got, c.want)
		}
	}
}

func TestEncodeURIComponent(t *testing.T) {
	got := EncodeURIComponent("hello world!@#$%^&*()_+-=[]{}|;:,.<>/?`~é中")
	want := "hello%20world!%40%23%24%25%5E%26*()_%2B-%3D%5B%5D%7B%7D%7C%3B%3A%2C.%3C%3E%2F%3F%60~%C3%A9%E4%B8%AD"
	if got != want {
		t.Errorf("EncodeURIComponent = %q, want %q", got, want)
	}
}

func TestEnvironmentSecrets(t *testing.T) {
	t.Setenv("MY_API_KEY", "sk-test-1234")
	t.Setenv("PLAIN_VAR", "sk-test-1234")
	t.Setenv("SHORT_TOKEN", "ab")
	secrets := EnvironmentSecrets()
	found := map[string]bool{}
	for _, s := range secrets {
		found[s] = true
	}
	if !found["sk-test-1234"] {
		t.Error("expected the raw secret value")
	}
	if !found[EncodeURIComponent("sk-test-1234")] {
		t.Error("expected the URI-encoded secret value")
	}
	for _, s := range secrets {
		if s == "ab" {
			t.Error("values of length <= 3 must be skipped")
		}
	}
	os.Unsetenv("PLAIN_VAR")
}
