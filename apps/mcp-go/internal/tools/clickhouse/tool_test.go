package clickhouse

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAuthenticationOverrides(t *testing.T) {
	t.Setenv("CLICKHOUSE_USER", "configured")
	t.Setenv("CLICKHOUSE_PASSWORD", "secret")
	captured := make(chan http.Header, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		captured <- r.Header.Clone()
		w.Write([]byte(`{"data":[]}`))
	}))
	defer server.Close()
	for _, tc := range []struct {
		name            string
		input           Input
		auth, user, key string
	}{
		{"key with configured user", Input{APIKey: "override"}, "", "configured", "override"},
		{"empty password", Input{Password: new(string)}, "Basic Y29uZmlndXJlZDo=", "", ""},
		{"case insensitive header override", Input{Headers: map[string]string{"AUTHORIZATION": "Bearer override"}}, "Bearer override", "", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in := tc.input
			in.ConnectionURL, in.SQL = server.URL, "SELECT 1"
			res, _, err := handle(context.Background(), nil, in)
			if err != nil || res.IsError {
				t.Fatalf("call failed: %v, %+v", err, res)
			}
			header := <-captured
			if header.Get("Authorization") != tc.auth || header.Get("X-ClickHouse-User") != tc.user || header.Get("X-ClickHouse-Key") != tc.key {
				t.Fatalf("unexpected authentication: %v", header)
			}
		})
	}
}
