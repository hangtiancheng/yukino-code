package commands

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/yukino-js/yukino/yukino/internal/storage"
)

func TestCommandUsageStableTiesAndSliceLimit(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	path := storage.YukinoPath("activity.jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	raw := `{"type":"checkpoint","projects":{},"inputs":[],"commandUsage":{"z":{"usageCount":1,"lastUsedAt":0},"a":{"usageCount":1,"lastUsedAt":0},"b":{"usageCount":1,"lastUsedAt":0}}}` + "\n"
	if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	tracker := CommandUsageTracker{}
	for _, test := range []struct {
		limit int
		want  []string
	}{{2, []string{"z", "a"}}, {-1, []string{"z", "a"}}, {0, []string{}}} {
		got, err := tracker.GetRecentlyUsed(test.limit)
		if err != nil || !reflect.DeepEqual(got, test.want) {
			t.Fatalf("limit %d: %v %v", test.limit, got, err)
		}
	}
	if got, err := tracker.GetRecentlyUsed(); err != nil || !reflect.DeepEqual(got, []string{"z", "a", "b"}) {
		t.Fatalf("default limit: %v %v", got, err)
	}
	if score, err := tracker.GetScore("z"); err != nil || score != 0.1 {
		t.Fatalf("score %f %v", score, err)
	}
}
