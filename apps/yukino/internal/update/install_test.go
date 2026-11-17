package update

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// fakePackageManager installs a stub executable for name on PATH that prints
// root on stdout (mirroring `npm root -g` / `yarn global dir`).
func fakePackageManager(t *testing.T, name, root string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake package managers use POSIX shell scripts")
	}
	dir := t.TempDir()
	script := "#!/bin/sh\necho '" + root + "'\n"
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

// fakePackageManagerExit installs a stub executable that exits with code.
func fakePackageManagerExit(t *testing.T, name string, code int) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake package managers use POSIX shell scripts")
	}
	dir := t.TempDir()
	script := "#!/bin/sh\nexit " + itoa(code) + "\n"
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	if n < 0 {
		return "-" + itoa(-n)
	}
	var digits []byte
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	return string(digits)
}

func TestPackageManagerInvocationWindows(t *testing.T) {
	command, args := PackageManagerInvocation("npm", []string{
		"install", "-g", "--prefix", `C:\O'Brien & $data`, PackageName + "@1.2.3",
	}, "windows")
	if command != "powershell.exe" {
		t.Fatalf("command = %q, want powershell.exe", command)
	}
	last := args[len(args)-1]
	if !strings.Contains(last, `'C:\O''Brien & $data'`) {
		t.Errorf("missing quoted prefix in %q", last)
	}
	if !strings.Contains(last, "exit $LASTEXITCODE") {
		t.Errorf("missing exit code propagation in %q", last)
	}
}

func TestPackageManagerInvocationUnix(t *testing.T) {
	command, args := PackageManagerInvocation("npm", []string{"root", "-g"}, "linux")
	if command != "npm" || len(args) != 2 || args[0] != "root" {
		t.Fatalf("unexpected invocation: %s %v", command, args)
	}
}

func TestSelfUpdateCommandNpmCustomPrefix(t *testing.T) {
	directory := t.TempDir()
	prefix := filepath.Join(directory, "custom prefix")
	installed := filepath.Join(prefix, "lib", "node_modules", PackageName)
	if err := os.MkdirAll(installed, 0o755); err != nil {
		t.Fatal(err)
	}
	fakePackageManager(t, "npm", filepath.Join(directory, "other npm", "lib", "node_modules"))

	command, err := GetSelfUpdateCommand(context.Background(), "1.2.3", installed)
	if err != nil {
		t.Fatalf("get command: %v", err)
	}
	if command.Command != PackageManagerNPM {
		t.Fatalf("command = %s, want npm", command.Command)
	}
	want := []string{"install", "-g", "--prefix", prefix, PackageName + "@1.2.3", "--registry=" + NPMRegistryURL}
	if strings.Join(command.Args, "|") != strings.Join(want, "|") {
		t.Fatalf("args = %v, want %v", command.Args, want)
	}
}

func TestSelfUpdateCommandYarn(t *testing.T) {
	directory := t.TempDir()
	root := filepath.Join(directory, "yarn", "global")
	installed := filepath.Join(root, "node_modules", PackageName)
	if err := os.MkdirAll(installed, 0o755); err != nil {
		t.Fatal(err)
	}
	fakePackageManager(t, "yarn", root)

	command, err := GetSelfUpdateCommand(context.Background(), "1.2.3", installed)
	if err != nil {
		t.Fatalf("get command: %v", err)
	}
	if command.Command != PackageManagerYarn {
		t.Fatalf("command = %s, want yarn", command.Command)
	}
	want := []string{"global", "add", PackageName + "@1.2.3", "--registry=" + NPMRegistryURL}
	if strings.Join(command.Args, "|") != strings.Join(want, "|") {
		t.Fatalf("args = %v, want %v", command.Args, want)
	}
}

func TestSelfUpdateCommandPnpm(t *testing.T) {
	directory := t.TempDir()
	root := filepath.Join(directory, "pnpm", "global", "5")
	installed := filepath.Join(root, ".pnpm", "yukino@1.0.0", "node_modules", PackageName)
	if err := os.MkdirAll(installed, 0o755); err != nil {
		t.Fatal(err)
	}
	fakePackageManager(t, "pnpm", filepath.Join(root, "node_modules"))

	command, err := GetSelfUpdateCommand(context.Background(), "1.2.3", installed)
	if err != nil {
		t.Fatalf("get command: %v", err)
	}
	if command.Command != PackageManagerPNPM {
		t.Fatalf("command = %s, want pnpm", command.Command)
	}
	want := []string{"install", "-g", PackageName + "@1.2.3", "--registry=" + NPMRegistryURL}
	if strings.Join(command.Args, "|") != strings.Join(want, "|") {
		t.Fatalf("args = %v, want %v", command.Args, want)
	}
}

func TestSelfUpdateCommandResolvesSymlinkedRoot(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink layout differs on Windows")
	}
	directory := t.TempDir()
	root := filepath.Join(directory, "actual", "node_modules")
	installed := filepath.Join(root, PackageName)
	if err := os.MkdirAll(installed, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(directory, "global-root")
	if err := os.Symlink(root, link); err != nil {
		t.Fatal(err)
	}
	fakePackageManager(t, "npm", link)

	command, err := GetSelfUpdateCommand(context.Background(), "1.2.3", installed)
	if err != nil {
		t.Fatalf("get command: %v", err)
	}
	if command.Command != PackageManagerNPM {
		t.Fatalf("command = %s, want npm", command.Command)
	}
}

func TestSelfUpdateCommandRejectsUnmanaged(t *testing.T) {
	directory := t.TempDir()
	fakePackageManager(t, "npm", filepath.Join(directory, "global", "node_modules"))
	for _, installed := range []string{
		filepath.Join(directory, "source"),
		filepath.Join(directory, "project", "node_modules", PackageName),
	} {
		if err := os.MkdirAll(installed, 0o755); err != nil {
			t.Fatal(err)
		}
		if _, err := GetSelfUpdateCommand(context.Background(), "1.2.3", installed); err == nil || !strings.Contains(err.Error(), "not managed by global") {
			t.Fatalf("expected unmanaged installation error for %s, got %v", installed, err)
		}
	}
}

func TestSelfUpdateCommandInfersPrefixWhenQueryFails(t *testing.T) {
	directory := t.TempDir()
	installed := filepath.Join(directory, "lib", "node_modules", PackageName)
	if err := os.MkdirAll(installed, 0o755); err != nil {
		t.Fatal(err)
	}
	// No npm on PATH: the query fails, but the custom prefix is inferred.
	t.Setenv("PATH", t.TempDir())

	command, err := GetSelfUpdateCommand(context.Background(), "1.2.3", installed)
	if err != nil {
		t.Fatalf("get command: %v", err)
	}
	found := false
	for _, arg := range command.Args {
		if arg == directory {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected inferred prefix %s in args %v", directory, command.Args)
	}
}

func TestRunSelfUpdateWaitsForExit(t *testing.T) {
	fakePackageManagerExit(t, "npm", 0)
	if err := RunSelfUpdate(&UpdateCommand{Command: PackageManagerNPM, Args: []string{"install", "-g", PackageName + "@1.2.3"}}); err != nil {
		t.Fatalf("run: %v", err)
	}
}

func TestRunSelfUpdateReportsFailures(t *testing.T) {
	fakePackageManagerExit(t, "pnpm", 1)
	err := RunSelfUpdate(&UpdateCommand{Command: PackageManagerPNPM, Args: []string{}})
	if err == nil || !strings.Contains(err.Error(), "pnpm") {
		t.Fatalf("expected pnpm failure, got %v", err)
	}
}

func TestRunSelfUpdateReportsSpawnFailure(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	err := RunSelfUpdate(&UpdateCommand{Command: PackageManagerNPM, Args: []string{}})
	if err == nil {
		t.Fatalf("expected spawn failure")
	}
}
