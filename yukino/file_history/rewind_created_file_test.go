package file_history

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRewindDeletesFileCreatedAfterTargetSnapshot(t *testing.T) {
	base := t.TempDir()
	projectDir := filepath.Join(base, "project")
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatal(err)
	}
	h := New(base, "session-1")

	// Round 1: no file changes at all, pure conversation — take a snapshot.
	h.MakeSnapshot(0, "Round 1")

	// Round 2: a new file is created. TrackEdit runs before the write, so the
	// file does not exist yet.
	newFile := filepath.Join(projectDir, "new_file.go")
	h.TrackEdit(newFile)
	if err := os.WriteFile(newFile, []byte("package main"), 0o644); err != nil {
		t.Fatal(err)
	}
	h.MakeSnapshot(2, "Round 2: new file created")

	if _, err := os.Stat(newFile); err != nil {
		t.Fatalf("newFile should exist before rewind: %v", err)
	}

	// Rewind to the round-1 snapshot, i.e. the state before this file was created.
	changed, err := h.Rewind(0)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(newFile); !os.IsNotExist(err) {
		t.Fatalf("the file should be deleted when rewinding to before its creation, but it still exists")
	}

	found := false
	for _, c := range changed {
		if c == newFile {
			found = true
		}
	}
	if !found {
		t.Fatalf("the changed list should contain the deleted file, got %v", changed)
	}
}

func TestRewindRestoresEditOnExistingFile(t *testing.T) {
	base := t.TempDir()
	projectDir := filepath.Join(base, "project")
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatal(err)
	}
	h := New(base, "session-1")

	existing := filepath.Join(projectDir, "existing.go")
	if err := os.WriteFile(existing, []byte("original"), 0o644); err != nil {
		t.Fatal(err)
	}

	h.TrackEdit(existing)
	h.MakeSnapshot(0, "Round 1: snapshot before modification")

	if err := os.WriteFile(existing, []byte("modified"), 0o644); err != nil {
		t.Fatal(err)
	}
	h.MakeSnapshot(2, "Round 2: content changed")

	changed, err := h.Rewind(0)
	if err != nil {
		t.Fatal(err)
	}

	data, err := os.ReadFile(existing)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "original" {
		t.Fatalf("expected 'original', got %q", string(data))
	}
	if len(changed) != 1 || changed[0] != existing {
		t.Fatalf("expected changed=[%s], got %v", existing, changed)
	}
}

func TestRewindToLatestSnapshotKeepsCreatedFile(t *testing.T) {
	base := t.TempDir()
	projectDir := filepath.Join(base, "project")
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatal(err)
	}
	h := New(base, "session-1")

	h.MakeSnapshot(0, "Round 1")

	newFile := filepath.Join(projectDir, "new_file.go")
	h.TrackEdit(newFile)
	if err := os.WriteFile(newFile, []byte("package main"), 0o644); err != nil {
		t.Fatal(err)
	}
	h.MakeSnapshot(2, "Round 2: new file created")

	// Rewind to this very snapshot, taken after the file was created: the file
	// must be kept (its content restored to what was written at the time).
	if _, err := h.Rewind(1); err != nil {
		t.Fatal(err)
	}

	data, err := os.ReadFile(newFile)
	if err != nil {
		t.Fatalf("newFile should still exist: %v", err)
	}
	if string(data) != "package main" {
		t.Fatalf("expected 'package main', got %q", string(data))
	}
}
