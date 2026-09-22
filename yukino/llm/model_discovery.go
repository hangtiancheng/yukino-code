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
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/hangtiancheng/yukino-code/yukino/config"
)

const discoveryTimeout = 5 * time.Second

const maxModelPages = 10

var (
	// ErrModelDiscoveryFailed mirrors the TS generic "Model discovery failed"
	// error that masks all underlying fetch/parse details.
	ErrModelDiscoveryFailed = errors.New("Model discovery failed")
	// ErrModelDiscoveryCancelled mirrors the TS AbortError thrown when the
	// caller's signal fired or the 5s discovery timeout elapsed.
	ErrModelDiscoveryCancelled = errors.New("Model discovery cancelled or timed out")
)

// DiscoveredModel mirrors the TS ModelSchema: id is required (trimmed,
// non-empty), display_name and name are optional.
type DiscoveredModel struct {
	ID          string
	DisplayName string
	Name        string
}

// rawModel mirrors the wire shape; pointers distinguish absent/null fields so
// validation can match the zod schema's strictness.
type rawModel struct {
	ID          *string `json:"id"`
	DisplayName *string `json:"display_name"`
	Name        *string `json:"name"`
}

// modelListResponse mirrors ModelListSchema: data is a required array,
// has_more an optional bool, last_id an optional nullable string.
type modelListResponse struct {
	Data    *[]rawModel `json:"data"`
	HasMore *bool       `json:"has_more"`
	LastID  *string     `json:"last_id"`
}

// discoveryPathSuffix matches the endpoint tails the TS modelListUrl strips
// before appending /models.
var discoveryPathSuffix = regexp.MustCompile(`/(?:chat/completions|completions|responses|messages|models)$`)

// ModelListURL mirrors the TS modelListUrl: it normalizes a provider base URL
// into its /models listing endpoint. It returns false when the URL is not an
// absolute HTTP(S) URL or embeds credentials.
func ModelListURL(protocol, baseURL string) (string, bool) {
	u, err := url.Parse(baseURL)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return "", false
	}
	// TS rejects only when `url.username || url.password`; an empty userinfo
	// ("http://:@host") is falsy there, so emptiness is what matters — not the
	// presence of the userinfo component itself.
	if u.User != nil {
		password, hasPassword := u.User.Password()
		if u.User.Username() != "" || (hasPassword && password != "") {
			return "", false
		}
	}

	path := strings.TrimRight(u.Path, "/")
	path = discoveryPathSuffix.ReplaceAllString(path, "")
	if path == "" || (protocol == "anthropic" && !strings.HasSuffix(path, "/v1")) {
		path += "/v1"
	}
	u.Path = path + "/models"
	u.RawPath = ""
	u.RawQuery = ""
	u.Fragment = ""
	return u.String(), true
}

// DiscoverModels mirrors the TS discoverModels: it pulls the provider's model
// list with a 5s timeout, following Anthropic's after_id pagination (max 10
// pages) and deduplicating by model id. Redirects are rejected like the TS
// redirect:"error". All failures collapse into ErrModelDiscoveryFailed, or
// ErrModelDiscoveryCancelled when ctx is cancelled or the timeout elapses.
//
// Unlike the streaming clients, this uses the raw cfg.APIKey (trimmed) rather
// than ResolveAPIKey, matching the TS which reads config.api_key directly.
func DiscoverModels(ctx context.Context, cfg *config.ProviderConfig) ([]DiscoveredModel, error) {
	endpoint, ok := ModelListURL(cfg.Protocol, cfg.BaseURL)
	if !ok {
		return nil, errors.New("Model discovery requires an HTTP(S) URL without embedded credentials")
	}

	ctx, cancel := context.WithTimeout(ctx, discoveryTimeout)
	defer cancel()

	apiKey := strings.TrimSpace(cfg.APIKey)
	headers := map[string]string{"Accept": "application/json"}
	if cfg.Protocol == "anthropic" {
		headers["anthropic-version"] = "2023-06-01"
		if apiKey != "" {
			headers["x-api-key"] = apiKey
		}
	} else if apiKey != "" {
		headers["Authorization"] = "Bearer " + apiKey
	}

	client := &http.Client{
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("redirects are not allowed")
		},
	}

	var models []DiscoveredModel
	seen := make(map[string]bool)
	cursors := make(map[string]bool)
	pageURL := endpoint

	for page := 0; page < maxModelPages; page++ {
		if ctx.Err() != nil {
			return nil, ErrModelDiscoveryCancelled
		}
		list, err := fetchModelPage(ctx, client, pageURL, headers)
		if err != nil {
			if ctx.Err() != nil {
				return nil, ErrModelDiscoveryCancelled
			}
			// TS collapses every fetch/parse failure into the generic error,
			// masking the underlying detail.
			return nil, ErrModelDiscoveryFailed
		}
		if list.Data == nil {
			return nil, ErrModelDiscoveryFailed
		}
		for _, raw := range *list.Data {
			if raw.ID == nil {
				return nil, ErrModelDiscoveryFailed
			}
			m := DiscoveredModel{ID: strings.TrimSpace(*raw.ID)}
			if m.ID == "" {
				return nil, ErrModelDiscoveryFailed
			}
			if raw.DisplayName != nil {
				m.DisplayName = *raw.DisplayName
			}
			if raw.Name != nil {
				m.Name = *raw.Name
			}
			if !seen[m.ID] {
				seen[m.ID] = true
				models = append(models, m)
			}
		}

		// Only the anthropic protocol paginates; everyone else gets one page.
		if cfg.Protocol != "anthropic" || list.HasMore == nil || !*list.HasMore {
			return models, nil
		}
		lastID := ""
		if list.LastID != nil {
			lastID = strings.TrimSpace(*list.LastID)
		}
		if lastID == "" || cursors[lastID] {
			return nil, ErrModelDiscoveryFailed
		}
		cursors[lastID] = true

		next, err := url.Parse(pageURL)
		if err != nil {
			return nil, ErrModelDiscoveryFailed
		}
		q := next.Query()
		q.Set("after_id", lastID)
		next.RawQuery = q.Encode()
		pageURL = next.String()
	}
	return nil, ErrModelDiscoveryFailed
}

func fetchModelPage(ctx context.Context, client *http.Client, pageURL string, headers map[string]string) (*modelListResponse, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, pageURL, nil)
	if err != nil {
		return nil, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("unexpected status %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	var list modelListResponse
	if err := json.Unmarshal(body, &list); err != nil {
		return nil, err
	}
	return &list, nil
}
