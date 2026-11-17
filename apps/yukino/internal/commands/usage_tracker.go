package commands

import (
	"math"
	"sort"
	"time"

	"github.com/yukino-js/yukino/yukino/internal/history"
)

// CommandUsageTracker scores commands by frequency with a recency half-life
// so the slash menu surfaces what the user actually reaches for.
type CommandUsageTracker struct{}

func (t CommandUsageTracker) score(entry history.CommandUsage, found bool, now time.Time) float64 {
	if !found {
		return 0
	}
	daysSince := math.Max(0, float64(now.UnixMilli()-entry.LastUsedAt)) / float64(MillisecondsPerDay)
	recency := math.Pow(0.5, daysSince/float64(CommandRecencyHalfLifeDays))
	return float64(entry.UsageCount) * math.Max(recency, CommandMinRecencyWeight)
}

func (t CommandUsageTracker) GetScore(name string) (float64, error) {
	entries, err := history.GetCommandUsage()
	if err != nil {
		return 0, err
	}
	usage, found := entries.Entries[name]
	return t.score(usage, found, time.Now()), nil
}

func (t CommandUsageTracker) GetRecentlyUsed(limits ...int) ([]string, error) {
	limit := 5
	if len(limits) > 0 {
		limit = limits[0]
	}
	now := time.Now()
	type scored struct {
		name  string
		score float64
	}
	var entries []scored
	usage, err := history.GetCommandUsage()
	if err != nil {
		return nil, err
	}
	for _, name := range usage.Order {
		if s := t.score(usage.Entries[name], true, now); s > 0 {
			entries = append(entries, scored{name: name, score: s})
		}
	}
	sort.SliceStable(entries, func(i, j int) bool { return entries[i].score > entries[j].score })
	if limit < 0 {
		limit = max(0, len(entries)+limit)
	}
	out := make([]string, 0, min(limit, len(entries)))
	for i, entry := range entries {
		if i >= limit {
			break
		}
		out = append(out, entry.name)
	}
	return out, nil
}
