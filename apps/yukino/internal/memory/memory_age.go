package memory

import (
	"fmt"
	"time"
)

func MemoryAgeDays(mtimeMs int64) int {
	d := (time.Now().UnixMilli() - mtimeMs) / MillisecondsPerDay
	if d < 0 {
		return 0
	}
	return int(d)
}

func MemoryAge(mtimeMs int64) string {
	d := MemoryAgeDays(mtimeMs)
	if d == 0 {
		return "today"
	}
	if d == 1 {
		return "yesterday"
	}
	return fmt.Sprintf("%d days ago", d)
}

// MemoryFreshnessText is the staleness reminder for memories at least 2 days
// old.
func MemoryFreshnessText(mtimeMs int64) string {
	d := MemoryAgeDays(mtimeMs)
	if d <= 1 {
		return ""
	}
	return fmt.Sprintf("Saved %d days ago; not live state. Code behavior and file:line citations may be stale. Verify against current code before asserting facts.", d)
}
