// Discovery of the Claude Code VSCode extension's embedded MCP server.
// The extension writes `$CLAUDE_CONFIG_DIR/ide/<port>.lock` (default
// `~/.claude/ide/`) on activation and injects CLAUDE_CODE_SSE_PORT into its
// integrated terminals; any CLI can use those to find and authenticate
// against the extension's WebSocket MCP server.
package vscode

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/text/unicode/norm"

	"github.com/yukino-js/yukino/yukino/internal/logger"
)

var log = logger.CreateChildLogger("vscode")

// DetectedIde mirrors the reference DetectedIde interface.
type DetectedIde struct {
	IdeName          string
	Port             int
	URL              string
	WorkspaceFolders []string
	AuthToken        string
	Pid              *int
}

// lockfile mirrors the zod LockfileSchema: every field optional, but present
// fields must have the declared type.
type lockfile struct {
	WorkspaceFolders []string `json:"workspaceFolders"`
	Pid              *int     `json:"pid"`
	IdeName          *string  `json:"ideName"`
	Transport        *string  `json:"transport"`
	AuthToken        *string  `json:"authToken"`
}

func IdeLockDir() string {
	configDir, ok := os.LookupEnv(ClaudeConfigDirEnvVar)
	if !ok {
		home, _ := os.UserHomeDir()
		configDir = filepath.Join(home, DefaultConfigDirName)
	}
	return filepath.Join(configDir, IdeLockDirName)
}

func cwdInWorkspace(cwd string, workspaceFolders []string) bool {
	// macOS returns NFD paths while VSCode reports NFC; normalize both sides.
	normalizedCwd := norm.NFC.String(cwd)
	for _, folder := range workspaceFolders {
		if folder == "" {
			continue
		}
		resolved, err := filepath.Abs(folder)
		if err != nil {
			resolved = folder
		}
		resolved = norm.NFC.String(resolved)
		if normalizedCwd == resolved || strings.HasPrefix(normalizedCwd, resolved+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

// jsParseInt mirrors JavaScript parseInt's leading-digits tolerance:
// "12abc" parses as 12; a string without leading digits fails.
func jsParseInt(value string) (int, bool) {
	trimmed := strings.TrimLeft(value, " \t\n\v\f\r")
	sign := 1
	if strings.HasPrefix(trimmed, "-") {
		sign = -1
		trimmed = trimmed[1:]
	} else if strings.HasPrefix(trimmed, "+") {
		trimmed = trimmed[1:]
	}
	digits := 0
	for digits < len(trimmed) && trimmed[digits] >= '0' && trimmed[digits] <= '9' {
		digits++
	}
	if digits == 0 {
		return 0, false
	}
	n, err := strconv.Atoi(trimmed[:digits])
	if err != nil {
		return 0, false
	}
	return sign * n, true
}

func readLockfile(dir, filename string) *DetectedIde {
	port, ok := jsParseInt(strings.TrimSuffix(filename, LockfileExtension))
	if !ok {
		return nil
	}
	content, err := os.ReadFile(filepath.Join(dir, filename))
	if err != nil {
		log.Error(map[string]any{"err": err, "filename": filename}, "failed to read IDE lockfile")
		return nil
	}
	var parsed lockfile
	if err := json.Unmarshal(content, &parsed); err != nil {
		log.Error(map[string]any{"err": err, "filename": filename}, "failed to read IDE lockfile")
		return nil
	}
	if parsed.Transport == nil || *parsed.Transport != LockfileWsTransport {
		// Only `transport: "ws"` is supported; legacy SSE lockfiles and entries
		// without a transport field are both rejected.
		return nil
	}
	ide := &DetectedIde{
		IdeName:          DefaultIdeName,
		Port:             port,
		URL:              "ws://" + IdeWsHost + ":" + strconv.Itoa(port),
		WorkspaceFolders: parsed.WorkspaceFolders,
	}
	if ide.WorkspaceFolders == nil {
		ide.WorkspaceFolders = []string{}
	}
	if parsed.IdeName != nil {
		ide.IdeName = *parsed.IdeName
	}
	if parsed.AuthToken != nil {
		ide.AuthToken = *parsed.AuthToken
	}
	if parsed.Pid != nil {
		pid := *parsed.Pid
		ide.Pid = &pid
	}
	return ide
}

// DetectIde finds the extension instance for this terminal. A lockfile matches
// when its port equals CLAUDE_CODE_SSE_PORT (set by the extension in its
// integrated terminal), or as a fallback when cwd is inside its workspace
// folders and the match is unambiguous.
func DetectIde(cwd string) *DetectedIde {
	dir := IdeLockDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil // no IDE lock directory → extension never ran
	}

	var lockfiles []*DetectedIde
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), LockfileExtension) {
			continue
		}
		ide := readLockfile(dir, entry.Name())
		if ide == nil {
			continue
		}
		// Stale lockfiles (extension crashed without cleanup) would win the
		// workspace match or make it ambiguous; drop entries with a dead pid.
		if ide.Pid != nil && !isPidAlive(*ide.Pid) {
			continue
		}
		lockfiles = append(lockfiles, ide)
	}

	if envPortValue, ok := os.LookupEnv(ClaudeCodeSSEPortEnvVar); ok && envPortValue != "" {
		if envPort, ok := jsParseInt(envPortValue); ok {
			for _, ide := range lockfiles {
				if ide.Port == envPort {
					return ide
				}
			}
		}
	}

	var byWorkspace []*DetectedIde
	for _, ide := range lockfiles {
		if cwdInWorkspace(cwd, ide.WorkspaceFolders) {
			byWorkspace = append(byWorkspace, ide)
		}
	}
	if len(byWorkspace) == 1 {
		return byWorkspace[0]
	}
	return nil
}
