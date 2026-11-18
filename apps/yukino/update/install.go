package update

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

type PackageManager string

const (
	PackageManagerNPM  PackageManager = "npm"
	PackageManagerYarn PackageManager = "yarn"
	PackageManagerPNPM PackageManager = "pnpm"
)

type UpdateCommand struct {
	Command PackageManager
	Args    []string
}

var (
	pnpmPathPattern = regexp.MustCompile(`/(\.pnpm|pnpm)/`)
	yarnPathPattern = regexp.MustCompile(`/(\.yarn|yarn)/`)
)

// PackageManagerInvocation wraps package-manager invocations for the platform.
// On Windows, PowerShell preserves literal arguments and can run the package
// managers' .cmd launchers.
func PackageManagerInvocation(command string, args []string, goos string) (string, []string) {
	if goos != "windows" {
		return command, args
	}
	parts := append([]string{command}, args...)
	quoted := make([]string, len(parts))
	for i, part := range parts {
		quoted[i] = "'" + strings.ReplaceAll(part, "'", "''") + "'"
	}
	invocation := strings.Join(quoted, " ")
	return "powershell.exe", []string{
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		"$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & " + invocation + "; exit $LASTEXITCODE",
	}
}

// PackageDirectory locates the installed @yukino.js/yukino package directory by
// walking upward from the running executable (the Go analogue of walking from
// the module file to the nearest matching package.json).
func PackageDirectory() (string, error) {
	executable, err := os.Executable()
	if err != nil {
		return "", errors.New(InstallationNotFoundError)
	}
	directory := filepath.Dir(executable)
	for {
		if data, err := os.ReadFile(filepath.Join(directory, "package.json")); err == nil {
			var pkg struct {
				Name string `json:"name"`
			}
			if json.Unmarshal(data, &pkg) == nil && pkg.Name == PackageName {
				return directory, nil
			}
		}
		parent := filepath.Dir(directory)
		if parent == directory {
			return "", errors.New(InstallationNotFoundError)
		}
		directory = parent
	}
}

func isInside(directory, root string) bool {
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return false
	}
	realDirectory, err := filepath.EvalSymlinks(directory)
	if err != nil {
		return false
	}
	child, err := filepath.Rel(realRoot, realDirectory)
	if err != nil {
		return false
	}
	return child != "" &&
		child != ".." &&
		!strings.HasPrefix(child, ".."+string(filepath.Separator)) &&
		!filepath.IsAbs(child)
}

// GetSelfUpdateCommand determines which package manager owns the installation
// and builds the global reinstall command for the given version.
func GetSelfUpdateCommand(ctx context.Context, latest, packageDirectory string) (*UpdateCommand, error) {
	if packageDirectory == "" {
		directory, err := PackageDirectory()
		if err != nil {
			return nil, err
		}
		packageDirectory = directory
	}
	normalized := strings.ToLower(strings.ReplaceAll(packageDirectory, "\\", "/"))
	command := PackageManagerNPM
	if pnpmPathPattern.MatchString(normalized) {
		command = PackageManagerPNPM
	} else if yarnPathPattern.MatchString(normalized) {
		command = PackageManagerYarn
	}

	queryArgs := []string{"root", "-g"}
	if command == PackageManagerYarn {
		queryArgs = []string{"global", "dir"}
	}
	queryCommand, queryInvocation := PackageManagerInvocation(string(command), queryArgs, runtime.GOOS)
	globalRoot := ""
	queryCtx, cancel := context.WithTimeout(ctx, time.Duration(PackageManagerQueryTimeoutMS)*time.Millisecond)
	output, err := exec.CommandContext(queryCtx, queryCommand, queryInvocation...).Output()
	cancel()
	if err == nil {
		// A custom npm prefix can still be inferred from the installation path.
		globalRoot = strings.TrimSpace(string(output))
	}

	npmRoot := filepath.Dir(filepath.Dir(packageDirectory))
	inferredNpmPrefix := ""
	if command == PackageManagerNPM && strings.HasSuffix(normalized, "/lib/node_modules/"+PackageName) {
		inferredNpmPrefix = filepath.Dir(filepath.Dir(npmRoot))
	}
	roots := []string{globalRoot}
	if inferredNpmPrefix != "" {
		roots = append(roots, npmRoot)
	}
	if command == PackageManagerPNPM && globalRoot != "" {
		roots = append(roots, filepath.Dir(globalRoot))
	}
	managed := false
	for _, root := range roots {
		if root != "" && isInside(packageDirectory, root) {
			managed = true
			break
		}
	}
	if !managed {
		return nil, errors.New(UnmanagedInstallationError)
	}

	var args []string
	if command == PackageManagerYarn {
		args = append(args, "global", "add")
	} else {
		args = append(args, "install", "-g")
	}
	if inferredNpmPrefix != "" {
		args = append(args, "--prefix", inferredNpmPrefix)
	}
	args = append(args, PackageName+"@"+latest, "--registry="+NPMRegistryURL)
	return &UpdateCommand{Command: command, Args: args}, nil
}

// RunSelfUpdate executes the update command with inherited stdio.
func RunSelfUpdate(update *UpdateCommand) error {
	command, args := PackageManagerInvocation(string(update.Command), update.Args, runtime.GOOS)
	child := exec.Command(command, args...)
	child.Stdin = os.Stdin
	child.Stdout = os.Stdout
	child.Stderr = os.Stderr
	if err := child.Run(); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return errors.New(terminationMessage(string(update.Command), exitErr))
		}
		return err
	}
	return nil
}
