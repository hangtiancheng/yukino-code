// Copyright (c) 2026 hangtiancheng
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

package llm

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/hangtiancheng/yukino-code/yukino/config"
)

func TestModelListURL(t *testing.T) {
	tests := []struct {
		name     string
		protocol string
		baseURL  string
		want     string
		wantOK   bool
	}{
		{name: "openai v1", protocol: "openai", baseURL: "https://api.example.com/v1", want: "https://api.example.com/v1/models", wantOK: true},
		{name: "trailing slash", protocol: "openai", baseURL: "https://api.example.com/v1/", want: "https://api.example.com/v1/models", wantOK: true},
		{name: "chat completions tail", protocol: "openai", baseURL: "https://api.example.com/v1/chat/completions", want: "https://api.example.com/v1/models", wantOK: true},
		{name: "completions tail", protocol: "openai", baseURL: "https://api.example.com/v1/completions", want: "https://api.example.com/v1/models", wantOK: true},
		{name: "responses tail", protocol: "openai", baseURL: "https://api.example.com/v1/responses", want: "https://api.example.com/v1/models", wantOK: true},
		{name: "messages tail", protocol: "openai", baseURL: "https://api.example.com/v1/messages", want: "https://api.example.com/v1/models", wantOK: true},
		{name: "models tail", protocol: "openai", baseURL: "https://api.example.com/v1/models", want: "https://api.example.com/v1/models", wantOK: true},
		{name: "bare host gets v1", protocol: "openai", baseURL: "https://api.example.com", want: "https://api.example.com/v1/models", wantOK: true},
		{name: "custom path kept", protocol: "openai", baseURL: "https://api.example.com/api", want: "https://api.example.com/api/models", wantOK: true},
		{name: "query and fragment dropped", protocol: "openai", baseURL: "https://api.example.com/v1?x=1#frag", want: "https://api.example.com/v1/models", wantOK: true},
		{name: "anthropic bare host", protocol: "anthropic", baseURL: "https://api.example.com", want: "https://api.example.com/v1/models", wantOK: true},
		{name: "anthropic v1 kept", protocol: "anthropic", baseURL: "https://api.example.com/v1", want: "https://api.example.com/v1/models", wantOK: true},
		{name: "anthropic custom path gains v1", protocol: "anthropic", baseURL: "https://api.example.com/api", want: "https://api.example.com/api/v1/models", wantOK: true},
		{name: "not a url", protocol: "openai", baseURL: "not a url", wantOK: false},
		{name: "missing scheme", protocol: "openai", baseURL: "api.example.com/v1", wantOK: false},
		{name: "ftp scheme", protocol: "openai", baseURL: "ftp://api.example.com/v1", wantOK: false},
		{name: "embedded credentials", protocol: "openai", baseURL: "https://user:pass@api.example.com/v1", wantOK: false},
		{name: "empty host", protocol: "openai", baseURL: "https://", wantOK: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := ModelListURL(tt.protocol, tt.baseURL)
			if ok != tt.wantOK {
				t.Fatalf("ModelListURL(%q, %q) ok = %v, want %v", tt.protocol, tt.baseURL, ok, tt.wantOK)
			}
			if ok && got != tt.want {
				t.Errorf("ModelListURL(%q, %q) = %q, want %q", tt.protocol, tt.baseURL, got, tt.want)
			}
		})
	}
}

func discoveryCfg(protocol, baseURL, apiKey string) *config.ProviderConfig {
	return &config.ProviderConfig{Protocol: protocol, BaseURL: baseURL, APIKey: apiKey}
}

func TestDiscoverModelsOpenAI(t *testing.T) {
	var gotAuth, gotAccept string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			t.Errorf("path = %q, want /v1/models", r.URL.Path)
		}
		gotAuth = r.Header.Get("Authorization")
		gotAccept = r.Header.Get("Accept")
		fmt.Fprint(w, `{"data":[{"id":"m1","display_name":"Model One"},{"id":"m2","name":"m2-name"}]}`)
	}))
	defer srv.Close()

	models, err := DiscoverModels(context.Background(), discoveryCfg("openai", srv.URL, "sk-test"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(models) != 2 {
		t.Fatalf("got %d models, want 2", len(models))
	}
	if models[0].ID != "m1" || models[0].DisplayName != "Model One" {
		t.Errorf("models[0] = %+v", models[0])
	}
	if models[1].ID != "m2" || models[1].Name != "m2-name" {
		t.Errorf("models[1] = %+v", models[1])
	}
	if gotAuth != "Bearer sk-test" {
		t.Errorf("Authorization = %q, want Bearer sk-test", gotAuth)
	}
	if gotAccept != "application/json" {
		t.Errorf("Accept = %q", gotAccept)
	}
}

func TestDiscoverModelsAnthropicPaginationAndDedup(t *testing.T) {
	var gotAPIKey, gotVersion string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAPIKey = r.Header.Get("x-api-key")
		gotVersion = r.Header.Get("anthropic-version")
		switch r.URL.Query().Get("after_id") {
		case "":
			fmt.Fprint(w, `{"data":[{"id":"a"}],"has_more":true,"last_id":"a"}`)
		case "a":
			// "a" repeats to prove first-occurrence dedup.
			fmt.Fprint(w, `{"data":[{"id":"b"},{"id":"a"}],"has_more":false}`)
		default:
			t.Errorf("unexpected after_id %q", r.URL.Query().Get("after_id"))
			w.WriteHeader(500)
		}
	}))
	defer srv.Close()

	models, err := DiscoverModels(context.Background(), discoveryCfg("anthropic", srv.URL, "ant-key"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(models) != 2 || models[0].ID != "a" || models[1].ID != "b" {
		t.Fatalf("models = %+v, want [a b]", models)
	}
	if gotAPIKey != "ant-key" {
		t.Errorf("x-api-key = %q, want ant-key", gotAPIKey)
	}
	if gotVersion != "2023-06-01" {
		t.Errorf("anthropic-version = %q", gotVersion)
	}
}

func TestDiscoverModelsAnthropicNoKeySendsNoAuth(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-api-key") != "" {
			t.Errorf("x-api-key must be absent for an empty api key")
		}
		fmt.Fprint(w, `{"data":[{"id":"a"}]}`)
	}))
	defer srv.Close()

	if _, err := DiscoverModels(context.Background(), discoveryCfg("anthropic", srv.URL, "  ")); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestDiscoverModelsOpenAIIgnoresPagination(t *testing.T) {
	pages := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		pages++
		fmt.Fprint(w, `{"data":[{"id":"m1"}],"has_more":true,"last_id":"cursor"}`)
	}))
	defer srv.Close()

	models, err := DiscoverModels(context.Background(), discoveryCfg("openai", srv.URL, "k"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if pages != 1 || len(models) != 1 {
		t.Errorf("pages = %d, models = %d; openai must stop after one page", pages, len(models))
	}
}

func TestDiscoverModelsFailures(t *testing.T) {
	tests := []struct {
		name    string
		handler http.HandlerFunc
	}{
		{
			name:    "non-2xx status",
			handler: func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(500) },
		},
		{
			name:    "invalid json",
			handler: func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, "{not json") },
		},
		{
			name:    "missing data field",
			handler: func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, `{"object":"list"}`) },
		},
		{
			name:    "null data field",
			handler: func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, `{"data":null}`) },
		},
		{
			name:    "model without id",
			handler: func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, `{"data":[{"name":"x"}]}`) },
		},
		{
			name:    "blank model id",
			handler: func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, `{"data":[{"id":"   "}]}`) },
		},
		{
			name:    "non-string id",
			handler: func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, `{"data":[{"id":42}]}`) },
		},
		{
			name: "has_more without last_id",
			handler: func(w http.ResponseWriter, _ *http.Request) {
				fmt.Fprint(w, `{"data":[{"id":"a"}],"has_more":true}`)
			},
		},
		{
			name: "repeated cursor",
			handler: func(w http.ResponseWriter, _ *http.Request) {
				fmt.Fprint(w, `{"data":[{"id":"a"}],"has_more":true,"last_id":"a"}`)
			},
		},
		{
			name: "redirect rejected",
			handler: func(w http.ResponseWriter, r *http.Request) {
				http.Redirect(w, r, "/elsewhere", http.StatusFound)
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// The repeated-cursor case needs two pages to fail; every handler above
			// answers identically, so the anthropic protocol exercises pagination.
			srv := httptest.NewServer(tt.handler)
			defer srv.Close()
			_, err := DiscoverModels(context.Background(), discoveryCfg("anthropic", srv.URL, "k"))
			if !errors.Is(err, ErrModelDiscoveryFailed) {
				t.Errorf("err = %v, want ErrModelDiscoveryFailed", err)
			}
		})
	}
}

func TestDiscoverModelsMaxPages(t *testing.T) {
	pages := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		pages++
		fmt.Fprintf(w, `{"data":[{"id":"m%d"}],"has_more":true,"last_id":"cursor-%d"}`, pages, pages)
	}))
	defer srv.Close()

	_, err := DiscoverModels(context.Background(), discoveryCfg("anthropic", srv.URL, "k"))
	if !errors.Is(err, ErrModelDiscoveryFailed) {
		t.Errorf("err = %v, want ErrModelDiscoveryFailed", err)
	}
	if pages != maxModelPages {
		t.Errorf("pages = %d, want %d", pages, maxModelPages)
	}
}

func TestDiscoverModelsCancelledContext(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"data":[{"id":"m1"}]}`)
	}))
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := DiscoverModels(ctx, discoveryCfg("openai", srv.URL, "k"))
	if !errors.Is(err, ErrModelDiscoveryCancelled) {
		t.Errorf("err = %v, want ErrModelDiscoveryCancelled", err)
	}
}

func TestDiscoverModelsInvalidBaseURL(t *testing.T) {
	_, err := DiscoverModels(context.Background(), discoveryCfg("openai", "not a url", "k"))
	if err == nil || errors.Is(err, ErrModelDiscoveryFailed) {
		t.Errorf("err = %v, want the invalid-URL error", err)
	}
}
