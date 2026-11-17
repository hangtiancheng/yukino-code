package operations

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHTTPBodyAbsentNullStringAndJSON(t *testing.T) {
	for _, test := range []struct{ name, raw, body, contentType string }{
		{"absent", "", "", ""},
		{"null", "null", "null", "application/json"},
		{"string", `"hello"`, "hello", ""},
		{"object", `{"a":1}`, `{"a":1}`, "application/json"},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				body, _ := io.ReadAll(r.Body)
				if string(body) != test.body || r.Header.Get("Content-Type") != test.contentType {
					t.Errorf("request body=%q, type=%q", body, r.Header.Get("Content-Type"))
				}
				if r.Header.Get("Authorization") != "Bearer token" {
					t.Error("authentication lost")
				}
				_, _ = w.Write([]byte(`{"ok":true}`))
			}))
			defer server.Close()
			out, err := RunHTTPPassthrough(context.Background(), server.URL, "BASE_URL", HTTPPassthroughAuth{Token: "token"}, HTTPPassthroughRequest{Method: "POST", Path: "/", Body: json.RawMessage(test.raw)}, nil)
			if err != nil || out.IsError || out.Data.(map[string]any)["ok"] != true {
				t.Fatalf("response: %#v, %v", out, err)
			}
		})
	}
}
