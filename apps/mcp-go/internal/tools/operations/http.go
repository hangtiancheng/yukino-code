package operations

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

// HTTPPassthroughAuth carries the configured bearer/basic credentials.
type HTTPPassthroughAuth struct {
	Token    string
	Username string
	Password string
}

// HTTPPassthroughRequest is one normalized HTTP-passthrough call.
type HTTPPassthroughRequest struct {
	BaseURL   string
	Path      string
	Method    string
	Params    map[string]any
	Body      any // nil | string | any JSON-serializable value
	Headers   map[string]string
	TimeoutMS int
}

// HTTPPassthroughOutcome is the normalized response.
type HTTPPassthroughOutcome struct {
	StatusCode int
	Data       any
	IsError    bool
}

func isAbsoluteHTTP(path string) bool {
	lower := strings.ToLower(path)
	return strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://")
}

// RunHTTPPassthrough executes one authenticated HTTP-passthrough call. It is a
// port of runHttpPassthrough: it resolves the base URL, applies configured
// bearer/basic authentication, sends the request and normalizes the response.
// isAPIError, when non-nil, lets a backend flag an in-band error on an
// otherwise 2xx response (e.g. Prometheus `status:"error"`).
func RunHTTPPassthrough(
	ctx context.Context,
	configuredBaseURL string,
	envName string,
	auth HTTPPassthroughAuth,
	req HTTPPassthroughRequest,
	isAPIError func(any) bool,
) (HTTPPassthroughOutcome, error) {
	base := req.BaseURL
	if base == "" {
		base = configuredBaseURL
	}
	if base == "" && !isAbsoluteHTTP(req.Path) {
		return HTTPPassthroughOutcome{}, fmt.Errorf("Connection is not configured. Set %s or supply base_url.", envName)
	}

	raw := req.Path
	if !isAbsoluteHTTP(req.Path) {
		raw = strings.TrimRight(base, "/") + "/" + strings.TrimLeft(req.Path, "/")
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return HTTPPassthroughOutcome{}, fmt.Errorf("invalid URL %q: %w", raw, err)
	}
	query := parsed.Query()
	for _, key := range sortedKeys(req.Params) {
		value := req.Params[key]
		if arr, ok := value.([]any); ok {
			for _, entry := range arr {
				query.Add(key, jsonValueToString(entry))
			}
			continue
		}
		query.Add(key, jsonValueToString(value))
	}
	parsed.RawQuery = query.Encode()

	httpReq, err := http.NewRequestWithContext(ctx, req.Method, parsed.String(), nil)
	if err != nil {
		return HTTPPassthroughOutcome{}, err
	}
	if auth.Token != "" {
		httpReq.Header.Set("Authorization", "Bearer "+auth.Token)
	} else if auth.Username != "" || auth.Password != "" {
		encoded := base64.StdEncoding.EncodeToString([]byte(auth.Username + ":" + auth.Password))
		httpReq.Header.Set("Authorization", "Basic "+encoded)
	}

	var bodyBytes []byte
	if req.Body != nil {
		if s, ok := req.Body.(string); ok {
			bodyBytes = []byte(s)
		} else {
			b, mErr := json.Marshal(req.Body)
			if mErr != nil {
				return HTTPPassthroughOutcome{}, mErr
			}
			bodyBytes = b
			httpReq.Header.Set("Content-Type", "application/json")
		}
		httpReq.Body = io.NopCloser(bytes.NewReader(bodyBytes))
		httpReq.ContentLength = int64(len(bodyBytes))
	}
	for _, key := range sortedKeys(req.Headers) {
		httpReq.Header.Set(key, req.Headers[key])
	}

	timeout := time.Duration(req.TimeoutMS) * time.Millisecond
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	callCtx, cancel := context.WithTimeout(httpReq.Context(), timeout)
	defer cancel()

	resp, err := http.DefaultClient.Do(httpReq.WithContext(callCtx))
	if err != nil {
		return HTTPPassthroughOutcome{}, err
	}
	defer resp.Body.Close()
	text, err := io.ReadAll(resp.Body)
	if err != nil {
		return HTTPPassthroughOutcome{}, err
	}

	var data any = string(text)
	if json.Valid(text) {
		var parsedBody any
		if uErr := json.Unmarshal(text, &parsedBody); uErr == nil {
			data = parsedBody
		}
	}
	apiError := false
	if isAPIError != nil {
		apiError = isAPIError(data)
	}
	return HTTPPassthroughOutcome{
		StatusCode: resp.StatusCode,
		Data:       data,
		IsError:    resp.StatusCode < 200 || resp.StatusCode >= 300 || apiError,
	}, nil
}

// jsonValueToString formats a decoded JSON scalar the way JavaScript's
// String(value) does, so query parameters match the TypeScript build.
func jsonValueToString(value any) string {
	switch v := value.(type) {
	case string:
		return v
	case bool:
		return strconv.FormatBool(v)
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	case json.Number:
		return v.String()
	case nil:
		return ""
	default:
		b, err := json.Marshal(v)
		if err != nil {
			return fmt.Sprintf("%v", v)
		}
		return string(b)
	}
}

// SortedKeys returns the map keys in sorted order, for deterministic query and
// header emission.
func SortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func sortedKeys[V any](m map[string]V) []string { return SortedKeys(m) }

// HTTPResult is the raw outcome of a Do call.
type HTTPResult struct {
	StatusCode int
	Header     http.Header
	Body       []byte
}

// Do sends one HTTP request with a timeout and returns the status, headers and
// body bytes. It is the low-level primitive shared by the JSON-gateway tools
// (etcd, milvus, clickhouse, minio). A nil body means no request body.
func Do(ctx context.Context, method, urlStr string, headers map[string]string, body []byte, timeoutMS int) (HTTPResult, error) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, urlStr, reader)
	if err != nil {
		return HTTPResult{}, err
	}
	if body != nil {
		req.ContentLength = int64(len(body))
	}
	for _, key := range sortedKeys(headers) {
		req.Header.Set(key, headers[key])
	}
	timeout := time.Duration(timeoutMS) * time.Millisecond
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	callCtx, cancel := context.WithTimeout(req.Context(), timeout)
	defer cancel()
	resp, err := http.DefaultClient.Do(req.WithContext(callCtx))
	if err != nil {
		return HTTPResult{}, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return HTTPResult{}, err
	}
	return HTTPResult{StatusCode: resp.StatusCode, Header: resp.Header, Body: raw}, nil
}

// ParseJSONOrText returns the body parsed as JSON when it is valid JSON, and
// the raw string otherwise. It mirrors the `try { JSON.parse } catch {}`
// pattern used across the TypeScript tools.
func ParseJSONOrText(body []byte) any {
	if len(body) == 0 {
		return string(body)
	}
	if !json.Valid(body) {
		return string(body)
	}
	var data any
	if err := json.Unmarshal(body, &data); err != nil {
		return string(body)
	}
	return data
}

// JoinURL builds an absolute URL from a base and a path. When path is already
// an absolute http(s) URL it is returned as-is; otherwise base and path are
// joined with a single slash.
func JoinURL(base, path string) string {
	if isAbsoluteHTTP(path) {
		return path
	}
	return strings.TrimRight(base, "/") + "/" + strings.TrimLeft(path, "/")
}

// IsAbsoluteHTTP reports whether path is an absolute http(s) URL.
func IsAbsoluteHTTP(path string) bool { return isAbsoluteHTTP(path) }

// JSONValueToString formats a decoded JSON scalar the way JavaScript's
// String(value) does. It is exported for tools that build query parameters
// from arbitrary scalar maps (e.g. ClickHouse params/settings).
func JSONValueToString(value any) string { return jsonValueToString(value) }
