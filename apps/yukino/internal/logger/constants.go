package logger

import "regexp"

// Only warn level and above (warn, error, fatal) are recorded, by design.
const (
	LogLevel       = "warn"
	SilentLogLevel = "silent"

	LogsDirName      = "logs"
	LogFileExtension = ".jsonl"
	LogExpiryDays    = 30

	DefaultNameSegment = "unnamed"

	CauseMaxDepth = 5
)

var UnsafeNameSegmentPattern = regexp.MustCompile(`[^a-zA-Z0-9_-]`)

var ReservedKeys = map[string]bool{"name": true, "message": true, "stack": true, "cause": true}
