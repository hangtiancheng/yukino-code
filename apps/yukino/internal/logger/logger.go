// Package logger mirrors src/logger: a root JSONL logger writing warn-and-above
// records to ~/.yukino/logs/<sessionId>.jsonl, plus child loggers carrying a
// module binding. Before InitLogger every call is a silent no-op (startup
// errors should use stderr directly), matching the reference's silent pino
// fallback behind a Proxy.
package logger

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/yukino-js/yukino/yukino/internal/storage"
)

// pino numeric levels.
const (
	levelTrace = 10
	levelDebug = 20
	levelInfo  = 30
	levelWarn  = 40
	levelError = 50
	levelFatal = 60
)

// teamsDirName mirrors TEAMS_DIR_NAME in teams/constants.ts. It is duplicated
// here because the teams package consumes the logger and Go forbids the
// resulting import cycle.
const teamsDirName = "teams"

// LoggerMode is the execution mode written into the base field of every record.
type LoggerMode string

const (
	ModeTerminal LoggerMode = "terminal"
	ModeRemote   LoggerMode = "remote"
	ModeTeammate LoggerMode = "teammate"
)

// InitLoggerOptions mirrors the reference InitLoggerOptions.
type InitLoggerOptions struct {
	// Session ID, used as the log filename and a base field.
	SessionID string
	// Execution mode.
	Mode LoggerMode
	// Override log directory (teammates use ~/.yukino/teams/<namespace>/<team>/logs/).
	LogDir string
	// Subprocess passes true to skip expired-log cleanup (avoid multi-process races).
	SkipCleanup bool
	// Mirror JSONL to stdout in addition to the log file. Only safe in remote
	// mode (the UI owns stdout).
	Stdout bool
}

type baseField struct {
	key   string
	value any
}

var (
	mu            sync.Mutex
	currentBase   []baseField // nil before InitLogger
	currentFile   *os.File
	currentPath   string
	currentStdout bool
)

// GetLogFilePath returns the active log file path, or "" before init/after close.
func GetLogFilePath() string {
	mu.Lock()
	defer mu.Unlock()
	return currentPath
}

// FlushLogger flushes the active destination buffer.
func FlushLogger() {
	mu.Lock()
	file := currentFile
	mu.Unlock()
	if file != nil {
		_ = file.Sync()
	}
}

func resolveLogPath(opts InitLoggerOptions) string {
	dir := opts.LogDir
	if dir == "" {
		dir = storage.YukinoPath(LogsDirName)
	}
	return filepath.Join(dir, opts.SessionID+LogFileExtension)
}

// SanitizeNameSegment sanitizes a filename segment to prevent path traversal
// (member names, etc.).
func SanitizeNameSegment(name string) string {
	cleaned := UnsafeNameSegmentPattern.ReplaceAllString(name, "_")
	if cleaned == "" {
		return DefaultNameSegment
	}
	return cleaned
}

// InitLogger initializes the root logger: creates the log file in append mode
// (multi-process safe, supports resume) and sets the base fields. Re-init
// closes the previous logger first. Unless SkipCleanup is set, expired-log
// cleanup runs in the background.
func InitLogger(opts InitLoggerOptions) error {
	CloseLogger()

	logPath := resolveLogPath(opts)
	file, err := storage.OpenPrivateFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY)
	if err != nil {
		return err
	}

	mu.Lock()
	currentFile = file
	currentPath = logPath
	currentStdout = opts.Stdout
	currentBase = []baseField{
		{key: "sessionId", value: opts.SessionID},
		{key: "mode", value: string(opts.Mode)},
	}
	mu.Unlock()

	if !opts.SkipCleanup {
		go func() {
			_ = CleanExpiredLogs()
		}()
	}
	return nil
}

// CloseLogger flushes and closes the log file. Registered on the exit path so
// buffered records reach disk.
func CloseLogger() {
	mu.Lock()
	file := currentFile
	currentFile = nil
	currentPath = ""
	currentBase = nil
	currentStdout = false
	mu.Unlock()
	if file != nil {
		_ = file.Sync()
		_ = file.Close()
	}
}

// Logger is a logging handle. Handles stay valid across InitLogger calls:
// records resolve the current root state at call time, mirroring the
// reference's Proxy forwarding. The zero value is the global logger.
type Logger struct {
	bindings map[string]any
}

// Global returns the module-level logger. Before InitLogger calls are silent
// no-ops.
func Global() *Logger { return &Logger{} }

// CreateChildLogger creates a module-level child logger, mirroring
// createChildLogger({ module }).
func CreateChildLogger(module string) *Logger {
	return &Logger{bindings: map[string]any{"module": module}}
}

func (l *Logger) Trace(fields map[string]any, msg string) { l.log(levelTrace, fields, msg) }
func (l *Logger) Debug(fields map[string]any, msg string) { l.log(levelDebug, fields, msg) }
func (l *Logger) Info(fields map[string]any, msg string)  { l.log(levelInfo, fields, msg) }
func (l *Logger) Warn(fields map[string]any, msg string)  { l.log(levelWarn, fields, msg) }
func (l *Logger) Error(fields map[string]any, msg string) { l.log(levelError, fields, msg) }
func (l *Logger) Fatal(fields map[string]any, msg string) { l.log(levelFatal, fields, msg) }

func (l *Logger) log(level int, fields map[string]any, msg string) {
	if level < levelWarn {
		return
	}
	mu.Lock()
	file := currentFile
	base := currentBase
	stdout := currentStdout
	if file == nil {
		mu.Unlock()
		return
	}
	line := encodeRecord(level, base, l.bindings, fields, msg)
	_, _ = file.Write(line)
	mu.Unlock()
	if stdout {
		_, _ = os.Stdout.Write(line)
	}
}

// encodeRecord builds one pino-compatible JSONL line. Key order mirrors pino:
// level, time, base fields, child bindings, merge fields (sorted for
// determinism — Go maps are unordered), msg.
func encodeRecord(level int, base []baseField, bindings, fields map[string]any, msg string) []byte {
	var buf bytes.Buffer
	buf.WriteString(`{"level":`)
	buf.WriteString(strconv.Itoa(level))
	buf.WriteString(`,"time":`)
	buf.WriteString(strconv.FormatInt(time.Now().UnixMilli(), 10))
	for _, f := range base {
		writeField(&buf, f.key, f.value)
	}
	for _, k := range sortedKeys(bindings) {
		writeField(&buf, k, bindings[k])
	}
	for _, k := range sortedKeys(fields) {
		v := fields[k]
		if k == "err" {
			v = SerializeErr(v)
		}
		writeField(&buf, k, v)
	}
	writeField(&buf, "msg", msg)
	buf.WriteByte('}')
	buf.WriteByte('\n')
	return buf.Bytes()
}

func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func writeField(buf *bytes.Buffer, key string, value any) {
	buf.WriteByte(',')
	keyJSON, err := json.Marshal(key)
	if err != nil {
		return
	}
	buf.Write(keyJSON)
	buf.WriteByte(':')
	valueJSON, err := json.Marshal(value)
	if err != nil {
		// json.Marshal only fails on values it cannot represent (channels,
		// cycles); fall back to a string rendering so logging never panics.
		valueJSON, _ = json.Marshal(fmt.Sprintf("%v", value))
	}
	buf.Write(valueJSON)
}

// SerializeErr mirrors the pino err serializer: error values become structured
// records with a recursive cause chain (max CauseMaxDepth); anything else is
// normalized to { message, value }. It never panics.
func SerializeErr(v any) any {
	if err, ok := v.(error); ok {
		return serializeErrorInstance(err, 0)
	}
	return map[string]any{"message": safeStringify(v), "value": v}
}

func serializeErrorInstance(err error, depth int) map[string]any {
	out := map[string]any{
		"type":    errorTypeName(err),
		"message": err.Error(),
	}
	if depth < CauseMaxDepth {
		if cause := errors.Unwrap(err); cause != nil {
			out["cause"] = serializeErrorInstance(cause, depth+1)
		}
	}
	return out
}

// errorTypeName returns the concrete type name, the closest Go analogue of
// Error.name. Go errors carry no stack, so the "stack" key is omitted.
func errorTypeName(err error) string {
	t := reflect.TypeOf(err)
	if t == nil {
		return "Error"
	}
	for t.Kind() == reflect.Ptr {
		t = t.Elem()
	}
	if t.Name() == "" {
		return "Error"
	}
	return t.Name()
}

// safeStringify renders an arbitrary value without ever panicking, mirroring
// the reference safeStringify.
func safeStringify(value any) string {
	if s, ok := value.(string); ok {
		return s
	}
	if data, err := json.Marshal(value); err == nil {
		return string(data)
	}
	return fmt.Sprintf("%v", value)
}

// cleanDir removes expired log files in a single directory and returns the
// count removed. Failures are silent.
func cleanDir(dir string) int {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	now := time.Now()
	expiry := time.Duration(LogExpiryDays) * 24 * time.Hour
	removed := 0
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), LogFileExtension) {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		info, err := os.Stat(path)
		if err != nil {
			continue
		}
		if now.Sub(info.ModTime()) > expiry {
			if os.Remove(path) == nil {
				removed++
			}
		}
	}
	return removed
}

// CleanExpiredLogs scans ~/.yukino/logs/ and every
// ~/.yukino/teams/<namespace>/<team>/logs/ directory, removing *.jsonl files
// older than LogExpiryDays. Only the main process calls it (teammate
// subprocesses pass SkipCleanup).
func CleanExpiredLogs() int {
	removed := cleanDir(storage.YukinoPath(LogsDirName))

	teamsDir := storage.YukinoPath(teamsDirName)
	namespaces, err := os.ReadDir(teamsDir)
	if err != nil {
		return removed
	}
	for _, namespace := range namespaces {
		teamNames, err := os.ReadDir(filepath.Join(teamsDir, namespace.Name()))
		if err != nil {
			continue
		}
		for _, teamName := range teamNames {
			removed += cleanDir(filepath.Join(teamsDir, namespace.Name(), teamName.Name(), LogsDirName))
		}
	}
	return removed
}
