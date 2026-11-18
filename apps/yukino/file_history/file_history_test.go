package file_history

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func newTestHistory(t *testing.T) (*History, string) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	project := t.TempDir()
	return New("session-fh"), project
}

func TestBaselineRestoresPreEditContent(t *testing.T) {
	h, project := newTestHistory(t)
	existing := filepath.Join(project, "file.txt")
	if err := os.WriteFile(existing, []byte("original"), 0o644); err != nil {
		t.Fatal(err)
	}
	h.MakeSnapshot(0, "before tracking", nil)

	// First edit after the target snapshot: the baseline must restore the
	// original content, not delete the file.
	h.TrackEdit(existing)
	if err := os.WriteFile(existing, []byte("edited"), 0o644); err != nil {
		t.Fatal(err)
	}

	changed, err := h.Rewind(0)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(existing)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "original" {
		t.Errorf("content = %q, want original", data)
	}
	if len(changed) != 1 || changed[0] != existing {
		t.Errorf("changed = %v", changed)
	}
}

func TestStatePersistsAcrossInstances(t *testing.T) {
	h, project := newTestHistory(t)
	file := filepath.Join(project, "a.txt")
	h.TrackEdit(file)
	if err := os.WriteFile(file, []byte("v1"), 0o644); err != nil {
		t.Fatal(err)
	}
	lineCount := 7
	h.MakeSnapshot(1, "snapshot text", &lineCount)

	reloaded := New("session-fh")
	if !reloaded.HasSnapshots() {
		t.Fatal("snapshots must persist")
	}
	snapshots := reloaded.GetSnapshots()
	if len(snapshots) != 1 {
		t.Fatalf("snapshots = %d", len(snapshots))
	}
	snapshot := snapshots[0]
	if snapshot.ID == "" || snapshot.MessageIndex != 1 || snapshot.UserText != "snapshot text" {
		t.Errorf("snapshot = %+v", snapshot)
	}
	if snapshot.SessionLineCount == nil || *snapshot.SessionLineCount != 7 {
		t.Errorf("sessionLineCount = %v", snapshot.SessionLineCount)
	}
	backup := snapshot.Backups[file]
	if backup.State != "existing" || backup.BackupPath == "" {
		t.Errorf("backup = %+v", backup)
	}
	if _, err := time.Parse("2006-01-02T15:04:05.000Z", snapshot.Timestamp); err != nil {
		t.Errorf("timestamp %q not ISO: %v", snapshot.Timestamp, err)
	}
	// The persisted state carries the version-2 schema.
	raw, err := os.ReadFile(filepath.Join(h.sessionDir, SnapshotsFileName))
	if err != nil {
		t.Fatal(err)
	}
	var state PersistedState
	if err := json.Unmarshal(raw, &state); err != nil {
		t.Fatal(err)
	}
	if state.Version != PersistedStateVersion || state.NextSnapshotSeq != 1 {
		t.Errorf("state = version %d seq %d", state.Version, state.NextSnapshotSeq)
	}
	if len(state.TrackedFiles) != 1 || len(state.Baselines) != 1 {
		t.Errorf("tracked = %v baselines = %v", state.TrackedFiles, state.Baselines)
	}
}

func TestUserTextTruncation(t *testing.T) {
	h, _ := newTestHistory(t)
	long := strings.Repeat("x", 100)
	h.MakeSnapshot(0, long, nil)
	snapshots := h.GetSnapshots()
	if snapshots[0].UserText != strings.Repeat("x", MaxSummaryTextLength)+"..." {
		t.Errorf("userText = %q", snapshots[0].UserText)
	}
}

func TestPruningDeletesBackupsAndKeepsSeqMonotonic(t *testing.T) {
	h, project := newTestHistory(t)
	file := filepath.Join(project, "a.txt")
	h.TrackEdit(file)
	for i := 0; i < MaxSnapshots+2; i++ {
		if err := os.WriteFile(file, []byte(fmt.Sprintf("v%d", i)), 0o644); err != nil {
			t.Fatal(err)
		}
		h.MakeSnapshot(i, fmt.Sprintf("snap %d", i), nil)
	}
	snapshots := h.GetSnapshots()
	if len(snapshots) != MaxSnapshots {
		t.Fatalf("snapshots = %d, want %d", len(snapshots), MaxSnapshots)
	}
	// The oldest snapshots were pruned; their backup files must be gone.
	entries, err := os.ReadDir(h.sessionDir)
	if err != nil {
		t.Fatal(err)
	}
	backupCount := 0
	for _, entry := range entries {
		if strings.Contains(entry.Name(), "@s") {
			backupCount++
		}
	}
	// MaxSnapshots snapshot backups + 1 baseline.
	if backupCount != MaxSnapshots {
		t.Errorf("backup files = %d, want %d (pruned backups must be deleted)", backupCount, MaxSnapshots)
	}
	// Backup names use the monotonic sequence: the newest snapshot's backup
	// carries seq MaxSnapshots+1, never a recycled index.
	newest := snapshots[len(snapshots)-1]
	wantName := getBackupName(file, MaxSnapshots+1)
	if !strings.HasSuffix(newest.Backups[file].BackupPath, wantName) {
		t.Errorf("newest backup = %q, want suffix %q", newest.Backups[file].BackupPath, wantName)
	}
}

func TestRewindInvalidIndex(t *testing.T) {
	h, _ := newTestHistory(t)
	if _, err := h.Rewind(0); err == nil || !strings.Contains(err.Error(), "Invalid snapshot index") {
		t.Errorf("err = %v", err)
	}
	h.MakeSnapshot(0, "x", nil)
	if _, err := h.Rewind(1); err == nil {
		t.Error("out-of-range index must fail")
	}
	if _, err := h.Rewind(-1); err == nil {
		t.Error("negative index must fail")
	}
}

func TestAbsentBackupDeletesOnRewind(t *testing.T) {
	h, project := newTestHistory(t)
	file := filepath.Join(project, "gone.txt")
	// Track while the file exists, snapshot after it disappears.
	h.TrackEdit(file)
	if err := os.WriteFile(file, []byte("here"), 0o644); err != nil {
		t.Fatal(err)
	}
	h.MakeSnapshot(0, "with file", nil)
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	h.MakeSnapshot(1, "without file", nil)
	if err := os.WriteFile(file, []byte("recreated"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Rewind to the snapshot where the file was absent.
	changed, err := h.Rewind(1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Error("absent backup must delete the recreated file")
	}
	if len(changed) != 1 {
		t.Errorf("changed = %v", changed)
	}
}
