package telemetry

import (
	"os"
	"testing"
)

// Key expectations byte-verified against src/telemetry/privacy.ts via npx tsx.
func TestScrubTelemetryPayloadSensitiveKeys(t *testing.T) {
	t.Setenv("MY_API_KEY", "")
	keys := []string{"authorization", "api_key", "apikey", "api-key", "token", "my_token", "token_x", "tokens", "tokenize", "access_token", "refresh-token", "private_key", "privatekey", "dsn", "my_dsn", "cookie", "set-cookie", "Cookie", "password", "secret", "credential", "x_credential_y", "Authorization"}
	obj := map[string]any{}
	for _, key := range keys {
		obj[key] = "VALUE"
	}
	ScrubTelemetryPayload(obj)
	for _, key := range keys {
		want := "VALUE"
		if key == "tokens" || key == "tokenize" {
			// Not matched by the sensitive key pattern.
		} else {
			want = RedactedPlaceholder
		}
		if obj[key] != want {
			t.Errorf("obj[%q] = %v, want %q", key, obj[key], want)
		}
	}
}

func TestScrubTelemetryPayloadStrings(t *testing.T) {
	t.Setenv("MY_API_KEY", "sk-super-secret-value")
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		t.Skip("no home directory")
	}
	payload := map[string]any{
		"msg":  "path " + home + "/x and bearer Bearer abc123 and key sk-super-secret-value",
		"list": []any{"plain", map[string]any{"nested": "secret sk-super-secret-value here"}},
		"keep": 42,
		"flag": true,
	}
	ScrubTelemetryPayload(payload)
	wantMsg := "path ~/x and bearer [redacted] abc123 and key [redacted]"
	if payload["msg"] != wantMsg {
		t.Errorf("msg = %q, want %q", payload["msg"], wantMsg)
	}
	list := payload["list"].([]any)
	if list[0] != "plain" {
		t.Errorf("list[0] = %v", list[0])
	}
	nested := list[1].(map[string]any)
	if nested["nested"] != "secret [redacted] here" {
		t.Errorf("nested = %v", nested["nested"])
	}
	if payload["keep"] != 42 || payload["flag"] != true {
		t.Errorf("non-string values changed: %v %v", payload["keep"], payload["flag"])
	}
}

func TestScrubTelemetryPayloadCycles(t *testing.T) {
	t.Setenv("MY_API_KEY", "")
	cyclic := map[string]any{"name": "ok"}
	cyclic["self"] = cyclic
	list := []any{"x"}
	list[0] = list
	ScrubTelemetryPayload(cyclic)
	ScrubTelemetryPayload(list)
	if cyclic["name"] != "ok" {
		t.Errorf("cyclic payload not scrubbed: %v", cyclic["name"])
	}
}

func TestScrubTelemetryPayloadTypedSlice(t *testing.T) {
	t.Setenv("MY_API_KEY", "sk-super-secret-value")
	strings := []string{"leak sk-super-secret-value", "clean"}
	ScrubTelemetryPayload(strings)
	if strings[0] != "leak [redacted]" || strings[1] != "clean" {
		t.Errorf("typed slice = %v", strings)
	}
}
