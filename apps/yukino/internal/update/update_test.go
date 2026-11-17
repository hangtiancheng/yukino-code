package update

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/yukino-js/yukino/yukino/internal/version"
)

// captureOutput swaps stdout/stderr for the duration of fn and returns what
// was written.
func captureOutput(t *testing.T, fn func()) (stdout, stderr string) {
	t.Helper()
	outR, outW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	errR, errW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	savedOut, savedErr := os.Stdout, os.Stderr
	os.Stdout, os.Stderr = outW, errW
	defer func() { os.Stdout, os.Stderr = savedOut, savedErr }()

	done := make(chan struct{})
	go func() {
		defer close(done)
		var outBuf, errBuf strings.Builder
		buf := make([]byte, 4096)
		for {
			n, err := outR.Read(buf)
			if n > 0 {
				outBuf.Write(buf[:n])
			}
			if err != nil {
				break
			}
		}
		for {
			n, err := errR.Read(buf)
			if n > 0 {
				errBuf.Write(buf[:n])
			}
			if err != nil {
				break
			}
		}
		stdout, stderr = outBuf.String(), errBuf.String()
	}()
	fn()
	outW.Close()
	errW.Close()
	<-done
	return stdout, stderr
}

type updateFixture struct {
	installCalls []string
	runCalls     int
	runErr       error
}

func (f *updateFixture) install(t *testing.T) {
	t.Helper()
	savedCommand, savedRun := selfUpdateCommand, selfUpdateRun
	t.Cleanup(func() { selfUpdateCommand, selfUpdateRun = savedCommand, savedRun })
	selfUpdateCommand = func(ctx context.Context, latest, packageDirectory string) (*UpdateCommand, error) {
		f.installCalls = append(f.installCalls, latest)
		return &UpdateCommand{Command: PackageManagerNPM}, nil
	}
	selfUpdateRun = func(update *UpdateCommand) error {
		f.runCalls++
		return f.runErr
	}
}

func registryReturning(t *testing.T, status int, body string) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		fmt.Fprint(w, body)
	}))
	t.Cleanup(server.Close)
	previous := packageURL
	packageURL = server.URL
	t.Cleanup(func() { packageURL = previous })
}

func TestRunUpdateInstallsCheckedVersion(t *testing.T) {
	saved := version.Version
	version.Version = "0.0.13-dev"
	t.Cleanup(func() { version.Version = saved })

	fixture := &updateFixture{}
	fixture.install(t)
	registryReturning(t, http.StatusOK, `{"version":"999.0.0"}`)

	stdout, stderr := captureOutput(t, func() {
		if code := RunUpdate(context.Background(), nil); code != 0 {
			t.Errorf("exit code = %d, want 0", code)
		}
	})
	if len(fixture.installCalls) != 1 || fixture.installCalls[0] != "999.0.0" {
		t.Fatalf("install calls = %v, want [999.0.0]", fixture.installCalls)
	}
	if fixture.runCalls != 1 {
		t.Fatalf("run calls = %d, want 1", fixture.runCalls)
	}
	if !strings.Contains(stdout, "Updated Yukino from v0.0.13-dev to v999.0.0.") {
		t.Fatalf("stdout = %q", stdout)
	}
	if stderr != "" {
		t.Fatalf("stderr = %q", stderr)
	}
}

func TestRunUpdateWithDistTags(t *testing.T) {
	saved := version.Version
	version.Version = "0.0.13-dev"
	t.Cleanup(func() { version.Version = saved })

	for _, tc := range []struct{ tag, latest string }{
		{"latest", "0.0.14"},
		{"canary", "0.0.14-canary"},
		{"dev", "0.0.14-dev"},
	} {
		tc := tc
		t.Run(tc.tag, func(t *testing.T) {
			fixture := &updateFixture{}
			fixture.install(t)
			registryReturning(t, http.StatusOK, fmt.Sprintf(`{"version":%q}`, tc.latest))
			stdout, _ := captureOutput(t, func() {
				if code := RunUpdate(context.Background(), &tc.tag); code != 0 {
					t.Errorf("exit code = %d, want 0", code)
				}
			})
			if len(fixture.installCalls) != 1 || fixture.installCalls[0] != tc.latest {
				t.Fatalf("install calls = %v, want [%s]", fixture.installCalls, tc.latest)
			}
			want := fmt.Sprintf("Updated Yukino from v0.0.13-dev to v%s.", tc.latest)
			if !strings.Contains(stdout, want) {
				t.Fatalf("stdout = %q, want %q", stdout, want)
			}
		})
	}
}

func TestRunUpdateDoesNotDowngrade(t *testing.T) {
	saved := version.Version
	version.Version = "0.0.13-dev"
	t.Cleanup(func() { version.Version = saved })

	for _, latest := range []string{"0.0.13-dev", "0.0.12", "0.0.13-canary"} {
		latest := latest
		t.Run(latest, func(t *testing.T) {
			fixture := &updateFixture{}
			fixture.install(t)
			registryReturning(t, http.StatusOK, fmt.Sprintf(`{"version":%q}`, latest))
			stdout, _ := captureOutput(t, func() {
				tag := "canary"
				if code := RunUpdate(context.Background(), &tag); code != 0 {
					t.Errorf("exit code = %d, want 0", code)
				}
			})
			if len(fixture.installCalls) != 0 || fixture.runCalls != 0 {
				t.Fatalf("expected no install for %s", latest)
			}
			if !strings.Contains(stdout, "Yukino is already up to date (v0.0.13-dev).") {
				t.Fatalf("stdout = %q", stdout)
			}
		})
	}
}

func TestRunUpdateMissingTagFails(t *testing.T) {
	fixture := &updateFixture{}
	fixture.install(t)
	registryReturning(t, http.StatusNotFound, "")

	_, stderr := captureOutput(t, func() {
		tag := "canary"
		if code := RunUpdate(context.Background(), &tag); code != 1 {
			t.Errorf("exit code = %d, want 1", code)
		}
	})
	if !strings.Contains(stderr, `Update failed: No Yukino release found for npm dist-tag "canary".`) {
		t.Fatalf("stderr = %q", stderr)
	}
	if len(fixture.installCalls) != 0 || fixture.runCalls != 0 {
		t.Fatalf("expected no install attempt")
	}
}

func TestRunUpdateFailureExitCodes(t *testing.T) {
	saved := version.Version
	version.Version = "0.0.13-dev"
	t.Cleanup(func() { version.Version = saved })

	t.Run("check failure", func(t *testing.T) {
		previous := packageURL
		packageURL = "http://127.0.0.1:1"
		t.Cleanup(func() { packageURL = previous })
		_, stderr := captureOutput(t, func() {
			if code := RunUpdate(context.Background(), nil); code != 1 {
				t.Errorf("exit code = %d, want 1", code)
			}
		})
		if !strings.HasPrefix(stderr, "Update failed:") {
			t.Fatalf("stderr = %q", stderr)
		}
	})

	t.Run("install failure", func(t *testing.T) {
		fixture := &updateFixture{runErr: fmt.Errorf("install failed")}
		fixture.install(t)
		registryReturning(t, http.StatusOK, `{"version":"999.0.0"}`)
		stdout, stderr := captureOutput(t, func() {
			if code := RunUpdate(context.Background(), nil); code != 1 {
				t.Errorf("exit code = %d, want 1", code)
			}
		})
		if !strings.HasPrefix(stderr, "Update failed:") {
			t.Fatalf("stderr = %q", stderr)
		}
		if strings.Contains(stdout, "Updated Yukino") {
			t.Fatalf("stdout = %q", stdout)
		}
	})
}

func TestRunUpdateRejectsInvalidTagsBeforeNetwork(t *testing.T) {
	for _, tag := range []string{"", "../latest"} {
		tag := tag
		t.Run(fmt.Sprintf("%q", tag), func(t *testing.T) {
			fixture := &updateFixture{}
			fixture.install(t)
			fetched := false
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fetched = true }))
			t.Cleanup(server.Close)
			previous := packageURL
			packageURL = server.URL
			t.Cleanup(func() { packageURL = previous })

			_, stderr := captureOutput(t, func() {
				if code := RunUpdate(context.Background(), &tag); code != 1 {
					t.Errorf("exit code = %d, want 1", code)
				}
			})
			if !strings.Contains(stderr, "Invalid npm dist-tag") {
				t.Fatalf("stderr = %q", stderr)
			}
			if fetched || fixture.runCalls != 0 {
				t.Fatalf("expected no network or install activity")
			}
		})
	}
}
