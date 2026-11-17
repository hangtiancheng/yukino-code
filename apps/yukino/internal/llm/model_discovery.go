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
)

var httpURLPattern = regexp.MustCompile(`^https?://`)

var modelPathSuffixes = regexp.MustCompile(`/(chat/completions|completions|responses|messages|models)$`)

type DiscoveredModel struct {
	ID          string `json:"id"`
	DisplayName string `json:"display_name,omitempty"`
	Name        string `json:"name,omitempty"`
}

type modelListResponse struct {
	Data []struct {
		ID          string `json:"id"`
		DisplayName string `json:"display_name"`
		Name        string `json:"name"`
	} `json:"data"`
	HasMore bool   `json:"has_more"`
	LastID  string `json:"last_id"`
}

// ModelListURL derives the /v1/models endpoint for a provider base URL. It
// returns "" when the URL is unusable (non-HTTP(S) or embedded credentials).
func ModelListURL(protocol, baseURL string) string {
	if !httpURLPattern.MatchString(baseURL) {
		return ""
	}
	parsed, err := url.Parse(baseURL)
	if err != nil {
		return ""
	}
	if (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil {
		return ""
	}
	path := strings.TrimRight(parsed.Path, "/")
	path = modelPathSuffixes.ReplaceAllString(path, "")
	if path == "" || (protocol == "anthropic" && !strings.HasSuffix(path, "/v1")) {
		path += "/v1"
	}
	parsed.Path = path + "/models"
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String()
}

type DiscoveryConfig struct {
	Protocol string
	BaseURL  string
	APIKey   string
}

func DiscoverModels(ctx context.Context, cfg DiscoveryConfig) ([]DiscoveredModel, error) {
	endpoint := ModelListURL(cfg.Protocol, cfg.BaseURL)
	if endpoint == "" {
		return nil, errors.New("Model discovery requires an HTTP(S) URL without embedded credentials")
	}

	ctx, cancel := context.WithTimeout(ctx, DiscoveryTimeout)
	defer cancel()

	headers := map[string]string{"Accept": "application/json"}
	apiKey := strings.TrimSpace(cfg.APIKey)
	if cfg.Protocol == "anthropic" {
		headers["anthropic-version"] = AnthropicAPIVersion
		if apiKey != "" {
			headers["x-api-key"] = apiKey
		}
	} else if apiKey != "" {
		headers["Authorization"] = "Bearer " + apiKey
	}

	client := &http.Client{
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}

	models := map[string]DiscoveredModel{}
	var order []string
	cursors := map[string]bool{}
	requestURL, err := url.Parse(endpoint)
	if err != nil {
		return nil, errors.New(ModelDiscoveryFailedError)
	}
	for page := 0; page < MaxModelPages; page++ {
		if err := ctx.Err(); err != nil {
			return nil, discoveryAbortError()
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL.String(), nil)
		if err != nil {
			return nil, errors.New(ModelDiscoveryFailedError)
		}
		for key, value := range headers {
			req.Header.Set(key, value)
		}
		resp, err := client.Do(req)
		if err != nil {
			if ctx.Err() != nil {
				return nil, discoveryAbortError()
			}
			return nil, errors.New(ModelDiscoveryFailedError)
		}
		body, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			return nil, errors.New(ModelDiscoveryFailedError)
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return nil, errors.New(ModelDiscoveryFailedError)
		}
		var list modelListResponse
		if err := json.Unmarshal(body, &list); err != nil {
			return nil, errors.New(ModelDiscoveryFailedError)
		}
		for _, model := range list.Data {
			id := strings.TrimSpace(model.ID)
			if id == "" {
				return nil, errors.New(ModelDiscoveryFailedError)
			}
			if _, seen := models[id]; !seen {
				models[id] = DiscoveredModel{ID: id, DisplayName: model.DisplayName, Name: model.Name}
				order = append(order, id)
			}
		}
		if cfg.Protocol != "anthropic" || !list.HasMore {
			out := make([]DiscoveredModel, 0, len(order))
			for _, id := range order {
				out = append(out, models[id])
			}
			return out, nil
		}
		lastID := strings.TrimSpace(list.LastID)
		if lastID == "" || cursors[lastID] {
			return nil, errors.New(ModelDiscoveryFailedError)
		}
		cursors[lastID] = true
		query := requestURL.Query()
		query.Set("after_id", lastID)
		requestURL.RawQuery = query.Encode()
	}
	return nil, errors.New(ModelDiscoveryFailedError)
}

func discoveryAbortError() error {
	return fmt.Errorf("Model discovery cancelled or timed out")
}
