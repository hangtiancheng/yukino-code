package memory

import (
	"testing"
	"time"
)

func TestMemoryAge(t *testing.T) {
	now := time.Now().UnixMilli()
	if got := MemoryAgeDays(now); got != 0 {
		t.Fatalf("today = %d", got)
	}
	if got := MemoryAgeDays(now - MillisecondsPerDay); got != 1 {
		t.Fatalf("yesterday = %d", got)
	}
	if got := MemoryAge(now - 3*MillisecondsPerDay); got != "3 days ago" {
		t.Fatalf("age = %q", got)
	}
}

func TestMemoryFreshnessText(t *testing.T) {
	now := time.Now().UnixMilli()
	if got := MemoryFreshnessText(now - MillisecondsPerDay); got != "" {
		t.Fatalf("1 day old should have no note, got %q", got)
	}
	want := "Saved 2 days ago; not live state. Code behavior and file:line citations may be stale. Verify against current code before asserting facts."
	if got := MemoryFreshnessText(now - 2*MillisecondsPerDay); got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}
