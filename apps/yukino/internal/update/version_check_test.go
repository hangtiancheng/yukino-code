package update

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"

	"github.com/yukino-js/yukino/yukino/internal/version"
)

func TestIsNewerVersion(t *testing.T) {
	cases := []struct {
		candidate string
		current   string
		newer     bool
	}{
		{"1.10.0", "1.9.0", true},
		{"1.0.0", "1.0.0", false},
		{"0.9.9", "1.0.0", false},
		{"0.0.13-dev", "0.0.12", true},
		{"0.0.13-canary", "0.0.12", true},
		{"0.0.14-canary", "0.0.13-dev", true},
		{"0.0.13-canary", "0.0.13-dev", false},
		{"1.0.0", "1.0.0-rc.2", true},
		{"1.0.0-rc.2", "1.0.0", false},
		{"1.0.0-beta.10", "1.0.0-beta.9", true},
		{"1.0.0-beta", "1.0.0-alpha", true},
		{"1.0.0-beta.1", "1.0.0-beta", true},
		{"1.0.0-1", "1.0.0-alpha", false},
		{"1.0.0+new", "1.0.0+old", false},
	}
	for _, tc := range cases {
		got, err := IsNewerVersion(tc.candidate, tc.current)
		if err != nil {
			t.Fatalf("IsNewerVersion(%s, %s) error: %v", tc.candidate, tc.current, err)
		}
		if got != tc.newer {
			t.Errorf("IsNewerVersion(%s, %s) = %v, want %v", tc.candidate, tc.current, got, tc.newer)
		}
	}
}

func TestParseVersionRejects(t *testing.T) {
	for _, invalid := range []string{"latest", "01.2.3", "1.2.3-01", "1.2.3;echo injected"} {
		if _, err := parseVersion(invalid); err == nil || !strings.Contains(err.Error(), "Invalid package version") {
			t.Errorf("parseVersion(%q) should be invalid, got %v", invalid, err)
		}
	}
}

func TestIsNewerVersionRejectsInvalid(t *testing.T) {
	if _, err := IsNewerVersion("1.0.0", "latest"); err == nil {
		t.Errorf("expected error for invalid current version")
	}
	if _, err := IsNewerVersion("latest", "1.0.0"); err == nil {
		t.Errorf("expected error for invalid candidate version")
	}
}

// withRegistry points packageURL at a local server for the duration of the test.
func withRegistry(t *testing.T, handler http.HandlerFunc) *http.Request {
	t.Helper()
	var captured *http.Request
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		captured = r.Clone(context.Background())
		handler(w, r)
	}))
	t.Cleanup(server.Close)
	previous := packageURL
	packageURL = server.URL
	t.Cleanup(func() { packageURL = previous })
	return captured
}

func jsonVersion(t *testing.T, v string) http.HandlerFunc {
	t.Helper()
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if v == "<number>" {
			fmt.Fprint(w, `{"version":12}`)
			return
		}
		fmt.Fprintf(w, `{"version":%q}`, v)
	}
}

func TestGetLatestVersionRequest(t *testing.T) {
	saved := version.Version
	version.Version = "0.0.13-dev"
	t.Cleanup(func() { version.Version = saved })

	var request *http.Request
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		request = r
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"version":"999.0.0"}`)
	}))
	t.Cleanup(server.Close)
	previous := packageURL
	packageURL = server.URL
	t.Cleanup(func() { packageURL = previous })

	got, err := CheckForUpdateResult(context.Background())
	if err != nil {
		t.Fatalf("check failed: %v", err)
	}
	if got != "999.0.0" {
		t.Fatalf("got %q, want 999.0.0", got)
	}
	if request.URL.Path != "/latest" {
		t.Errorf("path = %q, want /latest", request.URL.Path)
	}
	if request.Header.Get("accept") != "application/json" {
		t.Errorf("accept header = %q", request.Header.Get("accept"))
	}
	wantUA := fmt.Sprintf("yukino/0.0.13-dev (%s; %s)", runtime.GOOS, runtime.GOARCH)
	if request.Header.Get("User-Agent") != wantUA {
		t.Errorf("User-Agent = %q, want %q", request.Header.Get("User-Agent"), wantUA)
	}
}

// CheckForUpdateResult is a test helper mirroring getLatestVersion + comparison
// while surfacing errors (CheckForUpdate swallows them).
func CheckForUpdateResult(ctx context.Context) (string, error) {
	latest, err := GetLatestVersion(ctx, DefaultDistTag)
	if err != nil {
		return "", err
	}
	newer, err := IsNewerVersion(latest, version.Version)
	if err != nil {
		return "", err
	}
	if !newer {
		return "", nil
	}
	return latest, nil
}

func TestGetLatestVersionRejectsInvalidRegistryVersions(t *testing.T) {
	for _, invalid := range []string{"latest", "01.2.3", "1.2.3-01", "1.2.3;echo injected"} {
		invalid := invalid
		t.Run(invalid, func(t *testing.T) {
			withRegistry(t, jsonVersion(t, invalid))
			if _, err := GetLatestVersion(context.Background(), DefaultDistTag); err == nil || !strings.Contains(err.Error(), "Invalid package version") {
				t.Fatalf("expected invalid package version, got %v", err)
			}
		})
	}
}

func TestGetLatestVersionDistTags(t *testing.T) {
	cases := []struct{ tag, expected string }{
		{"canary", "0.0.14-canary"},
		{"next", "0.0.14-dev"},
		{"preview-branch.1", "0.0.14"},
		{"latest", "0.0.14-dev"},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.tag, func(t *testing.T) {
			var path string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				path = r.URL.Path
				w.Header().Set("Content-Type", "application/json")
				fmt.Fprintf(w, `{"version":%q}`, tc.expected)
			}))
			t.Cleanup(server.Close)
			previous := packageURL
			packageURL = server.URL
			t.Cleanup(func() { packageURL = previous })

			got, err := GetLatestVersion(context.Background(), tc.tag)
			if err != nil {
				t.Fatalf("get failed: %v", err)
			}
			if got != tc.expected {
				t.Fatalf("got %q, want %q", got, tc.expected)
			}
			if path != "/"+tc.tag {
				t.Errorf("path = %q, want /%s", path, tc.tag)
			}
		})
	}
}

func TestGetLatestVersionRejectsInvalidTags(t *testing.T) {
	for _, tag := range []string{"", " ", "bad tag", "../latest", "canary?x=1", "canary#latest", ".", ".."} {
		tag := tag
		t.Run(fmt.Sprintf("%q", tag), func(t *testing.T) {
			fetched := false
			withRegistry(t, func(w http.ResponseWriter, r *http.Request) { fetched = true })
			if _, err := GetLatestVersion(context.Background(), tag); err == nil || !strings.Contains(err.Error(), "Invalid npm dist-tag") {
				t.Fatalf("expected invalid dist-tag error, got %v", err)
			}
			if fetched {
				t.Fatalf("registry must not be contacted for invalid tag")
			}
		})
	}
}

func TestGetLatestVersionMissingTag(t *testing.T) {
	withRegistry(t, func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	})
	_, err := GetLatestVersion(context.Background(), "canary")
	if err == nil || err.Error() != `No Yukino release found for npm dist-tag "canary".` {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestGetLatestVersionHTTPErrorAndMalformed(t *testing.T) {
	withRegistry(t, func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
	})
	if _, err := GetLatestVersion(context.Background(), DefaultDistTag); err == nil || !strings.Contains(err.Error(), "HTTP 503") {
		t.Fatalf("expected HTTP 503 error, got %v", err)
	}
	withRegistry(t, jsonVersion(t, "<number>"))
	if _, err := GetLatestVersion(context.Background(), DefaultDistTag); err == nil {
		t.Fatalf("expected error for non-string version")
	}
}

func TestCheckForUpdate(t *testing.T) {
	saved := version.Version
	version.Version = "0.0.13-dev"
	t.Cleanup(func() { version.Version = saved })

	withRegistry(t, jsonVersion(t, "999.0.0"))
	if got := CheckForUpdate(context.Background()); got != "999.0.0" {
		t.Fatalf("got %q, want 999.0.0", got)
	}
	for _, same := range []string{"0.0.13-dev", "0.0.0"} {
		withRegistry(t, jsonVersion(t, same))
		if got := CheckForUpdate(context.Background()); got != "" {
			t.Fatalf("expected no update for %s, got %q", same, got)
		}
	}
}

func TestCheckForUpdateSuppressesFailures(t *testing.T) {
	previous := packageURL
	packageURL = "http://127.0.0.1:1"
	t.Cleanup(func() { packageURL = previous })
	if got := CheckForUpdate(context.Background()); got != "" {
		t.Fatalf("expected suppressed failure, got %q", got)
	}
}
