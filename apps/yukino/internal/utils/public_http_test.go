package utils

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestIsPublicIPAddress(t *testing.T) {
	public := []string{"8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"}
	for _, address := range public {
		if !IsPublicIPAddress(address) {
			t.Errorf("%s must be public", address)
		}
	}
	blocked := []string{
		"127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.0.1", "169.254.169.254",
		"0.0.0.0", "255.255.255.255", "224.0.0.1", "240.0.0.1", "100.64.0.1",
		"198.18.0.1", "203.0.113.5", "::1", "::", "fe80::1", "ff00::1",
		"2001:db8::1", "::ffff:127.0.0.1", "not-an-ip",
	}
	for _, address := range blocked {
		if IsPublicIPAddress(address) {
			t.Errorf("%s must be blocked", address)
		}
	}
}

func TestFetchPublicHttpUrlProtocolAndCredentials(t *testing.T) {
	ctx := context.Background()
	if _, err := FetchPublicHttpUrl(ctx, "ftp://example.com/x", "GET", nil, PublicHttpDependencies{}); err == nil || err.Error() != SkillURLProtocolError {
		t.Errorf("protocol err = %v", err)
	}
	if _, err := FetchPublicHttpUrl(ctx, "https://user:pass@example.com/x", "GET", nil, PublicHttpDependencies{}); err == nil || err.Error() != SkillURLCredentialsError {
		t.Errorf("credentials err = %v", err)
	}
	if _, err := FetchPublicHttpUrl(ctx, "https://example.com/x", "POST", nil, PublicHttpDependencies{}); err == nil ||
		!strings.Contains(err.Error(), "only supports GET or HEAD") {
		t.Errorf("method err = %v", err)
	}
}

func TestFetchPublicHttpUrlNonPublicResolution(t *testing.T) {
	ctx := context.Background()
	lookup := func(_ context.Context, hostname string) ([]LookupAddress, error) {
		return []LookupAddress{{Address: "127.0.0.1", Family: 4}}, nil
	}
	_, err := FetchPublicHttpUrl(ctx, "https://evil.example.com/x", "GET", nil, PublicHttpDependencies{Lookup: lookup})
	if err == nil || err.Error() != SkillURLNonPublicError {
		t.Errorf("non-public err = %v", err)
	}
	// Every resolved address must be public (mixed result is rejected).
	mixed := func(_ context.Context, hostname string) ([]LookupAddress, error) {
		return []LookupAddress{{Address: "8.8.8.8", Family: 4}, {Address: "10.0.0.1", Family: 4}}, nil
	}
	_, err = FetchPublicHttpUrl(ctx, "https://evil.example.com/x", "GET", nil, PublicHttpDependencies{Lookup: mixed})
	if err == nil || err.Error() != SkillURLNonPublicError {
		t.Errorf("mixed err = %v", err)
	}
	// Empty resolution is rejected.
	empty := func(_ context.Context, hostname string) ([]LookupAddress, error) { return nil, nil }
	if _, err := FetchPublicHttpUrl(ctx, "https://x.example.com/", "GET", nil, PublicHttpDependencies{Lookup: empty}); err == nil || err.Error() != SkillURLNonPublicError {
		t.Errorf("empty err = %v", err)
	}
}

func cannedFetcher(handler func(req *http.Request) *http.Response) func(*http.Request) (*http.Response, error) {
	return func(req *http.Request) (*http.Response, error) {
		return handler(req), nil
	}
}

func publicLookup() HostLookup {
	return func(_ context.Context, hostname string) ([]LookupAddress, error) {
		return []LookupAddress{{Address: "93.184.216.34", Family: 4}}, nil
	}
}

func TestFetchPublicHttpUrlRedirects(t *testing.T) {
	ctx := context.Background()
	hops := 0
	fetcher := cannedFetcher(func(req *http.Request) *http.Response {
		hops++
		if hops <= 2 {
			return &http.Response{
				StatusCode: 302,
				Header:     http.Header{"Location": []string{"https://example.com/next"}},
				Body:       http.NoBody,
			}
		}
		return &http.Response{
			StatusCode: 200,
			Header:     http.Header{},
			Body:       io.NopCloser(strings.NewReader("payload")),
		}
	})
	resp, err := FetchPublicHttpUrl(ctx, "https://example.com/start", "GET", nil, PublicHttpDependencies{Fetcher: fetcher, Lookup: publicLookup()})
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	if string(body) != "payload" || hops != 3 {
		t.Errorf("body = %q hops = %d", body, hops)
	}
}

func TestFetchPublicHttpUrlRedirectLimits(t *testing.T) {
	ctx := context.Background()
	fetcher := cannedFetcher(func(req *http.Request) *http.Response {
		return &http.Response{
			StatusCode: 301,
			Header:     http.Header{"Location": []string{"https://example.com/loop"}},
			Body:       http.NoBody,
		}
	})
	_, err := FetchPublicHttpUrl(ctx, "https://example.com/start", "GET", nil, PublicHttpDependencies{Fetcher: fetcher, Lookup: publicLookup()})
	if err == nil || !strings.Contains(err.Error(), "exceeded 5 redirects") {
		t.Errorf("redirect limit err = %v", err)
	}

	noLocation := cannedFetcher(func(req *http.Request) *http.Response {
		return &http.Response{StatusCode: 307, Header: http.Header{}, Body: http.NoBody}
	})
	_, err = FetchPublicHttpUrl(ctx, "https://example.com/start", "GET", nil, PublicHttpDependencies{Fetcher: noLocation, Lookup: publicLookup()})
	if err == nil || err.Error() != SkillURLMissingLocationError {
		t.Errorf("missing location err = %v", err)
	}
}

func TestFetchPublicHttpUrlRedirectRevalidatesEachHop(t *testing.T) {
	ctx := context.Background()
	hops := 0
	fetcher := cannedFetcher(func(req *http.Request) *http.Response {
		hops++
		return &http.Response{
			StatusCode: 302,
			Header:     http.Header{"Location": []string{"https://internal.example.com/admin"}},
			Body:       http.NoBody,
		}
	})
	lookup := func(_ context.Context, hostname string) ([]LookupAddress, error) {
		if hostname == "internal.example.com" {
			return []LookupAddress{{Address: "192.168.0.1", Family: 4}}, nil
		}
		return []LookupAddress{{Address: "93.184.216.34", Family: 4}}, nil
	}
	_, err := FetchPublicHttpUrl(ctx, "https://example.com/start", "GET", nil, PublicHttpDependencies{Fetcher: fetcher, Lookup: lookup})
	if err == nil || err.Error() != SkillURLNonPublicError {
		t.Errorf("redirect revalidation err = %v", err)
	}
	if hops != 1 {
		t.Errorf("hops = %d, want 1 (redirect target must never be fetched)", hops)
	}
}
