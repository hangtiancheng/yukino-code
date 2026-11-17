package file_history

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRewindDeletesFileCreatedAfterTargetSnapshot(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	projectDir := filepath.Join(t.TempDir(), "project")
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatal(err)
	}
	h := New("session-1")

	h.MakeSnapshot(0, "round one", nil)

	newFile := filepath.Join(projectDir, "new_file.go")
	h.TrackEdit(newFile)
	if err := os.WriteFile(newFile, []byte("package main"), 0o644); err != nil {
		t.Fatal(err)
	}
	h.MakeSnapshot(2, "round two: create file", nil)

	if _, err := os.Stat(newFile); err != nil {
		t.Fatalf("newFile should exist before rewind: %v", err)
	}

	changed, err := h.Rewind(0)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(newFile); !os.IsNotExist(err) {
		t.Fatalf("rewinding before the file was created should delete it, but it still exists")
	}

	found := false
	for _, c := range changed {
		if c == newFile {
			found = true
		}
	}
	if !found {
		t.Fatalf("changed list should contain the deleted file, got %v", changed)
	}
}

func TestRewindRestoresEditOnExistingFile(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	projectDir := filepath.Join(t.TempDir(), "project")
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatal(err)
	}
	h := New("session-1")

	existing := filepath.Join(projectDir, "existing.go")
	if err := os.WriteFile(existing, []byte("original"), 0o644); err != nil {
		t.Fatal(err)
	}

	h.TrackEdit(existing)
	h.MakeSnapshot(0, "round one: snapshot before edit", nil)

	if err := os.WriteFile(existing, []byte("modified"), 0o644); err != nil {
		t.Fatal(err)
	}
	h.MakeSnapshot(2, "round two: content changed", nil)

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
	t.Setenv("HOME", t.TempDir())
	projectDir := filepath.Join(t.TempDir(), "project")
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatal(err)
	}
	h := New("session-1")

	h.MakeSnapshot(0, "round one", nil)

	newFile := filepath.Join(projectDir, "new_file.go")
	h.TrackEdit(newFile)
	if err := os.WriteFile(newFile, []byte("package main"), 0o644); err != nil {
		t.Fatal(err)
	}
	h.MakeSnapshot(2, "round two: create file", nil)

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
