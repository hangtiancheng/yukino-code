package sandbox

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/yukino-js/yukino/yukino/internal/utils"
)

const SandboxExecPath = "/usr/bin/sandbox-exec"
const SeatbeltPathInvalidCharactersError = "Seatbelt paths cannot contain NUL or newline characters"

type SeatbeltSandbox struct{}

func (s *SeatbeltSandbox) Implementation() string { return "seatbelt" }
func (s *SeatbeltSandbox) Available() bool        { _, err := os.Stat(SandboxExecPath); return err == nil }
func (s *SeatbeltSandbox) Prepare(ctx context.Context, command string, config Config, cwd string) (PreparedCommand, error) {
	if err := ctx.Err(); err != nil {
		return PreparedCommand{}, err
	}
	config.AllowWrite = append([]string(nil), config.AllowWrite...)
	config.DenyWrite = append([]string(nil), config.DenyWrite...)
	for i, path := range config.AllowWrite {
		config.AllowWrite[i] = utils.ResolveToolPath(cwd, path)
	}
	for i, path := range config.DenyWrite {
		config.DenyWrite[i] = utils.ResolveToolPath(cwd, path)
	}
	profile, err := buildProfile(config)
	if err != nil {
		return PreparedCommand{}, err
	}
	return PreparedCommand{Executable: SandboxExecPath, Args: []string{"-p", profile, "bash", "-c", command}}, nil
}
func pathVariants(path string) []string {
	variants := []string{path}
	if real, err := filepath.EvalSymlinks(path); err == nil && real != path {
		variants = append(variants, real)
	}
	return variants
}
func quoteProfileString(value string) (string, error) {
	if strings.ContainsAny(value, "\x00\r\n") {
		return "", errors.New(SeatbeltPathInvalidCharactersError)
	}
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(value) + `"`, nil
}
func buildProfile(config Config) (string, error) {
	lines := []string{"(version 1)", "(deny default)", "(allow process-exec)", "(allow process-fork)", "(allow sysctl-read)", `(allow file-read* (subpath "/"))`, `(allow file-write* (literal "/dev/null"))`}
	for _, path := range config.AllowWrite {
		for _, variant := range pathVariants(path) {
			quoted, err := quoteProfileString(variant)
			if err != nil {
				return "", err
			}
			lines = append(lines, "(allow file-write* (subpath "+quoted+"))")
		}
	}
	for _, path := range config.DenyWrite {
		for _, variant := range pathVariants(path) {
			quoted, err := quoteProfileString(variant)
			if err != nil {
				return "", err
			}
			lines = append(lines, "(deny file-write* (literal "+quoted+"))", "(deny file-write* (subpath "+quoted+"))")
		}
	}
	if config.NetworkEnabled {
		lines = append(lines, "(allow network*)")
	} else {
		lines = append(lines, "(deny network*)")
	}
	return strings.Join(lines, "\n"), nil
}
