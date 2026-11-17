package file_history

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/google/uuid"

	"github.com/yukino-js/yukino/yukino/internal/logger"
	"github.com/yukino-js/yukino/yukino/internal/storage"
)

const (
	FileHistoryDirName    = "file-history"
	SnapshotsFileName     = "snapshots.json"
	PersistedStateVersion = 2

	MaxSnapshots         = 100
	MaxSummaryTextLength = 60
)

var log = logger.CreateChildLogger("file-history")

// Backup is the discriminated per-file backup state of a snapshot.
type Backup struct {
	State      string `json:"state"` // existing | absent | unavailable
	BackupPath string `json:"backupPath,omitempty"`
	Time       string `json:"time"`
}

// Snapshot is one rewind checkpoint. SessionLineCount is the authoritative
// rewind coordinate: unlike MessageIndex it survives resume and compaction.
type Snapshot struct {
	ID               string            `json:"id"`
	MessageIndex     int               `json:"messageIndex"`
	UserText         string            `json:"userText"`
	Backups          map[string]Backup `json:"backups"`
	Timestamp        string            `json:"timestamp"`
	SessionLineCount *int              `json:"sessionLineCount,omitempty"`
}

// FileBaseline captures the file state immediately before its first edit in
// this history branch.
type FileBaseline struct {
	State      string `json:"state"` // existing | absent | unavailable
	BackupPath string `json:"backupPath,omitempty"`
}

type PersistedState struct {
	Version         int                     `json:"version"`
	TrackedFiles    []string                `json:"trackedFiles"`
	Snapshots       []Snapshot              `json:"snapshots"`
	Baselines       map[string]FileBaseline `json:"baselines,omitempty"`
	NextSnapshotSeq int                     `json:"nextSnapshotSeq"`
}

// FileHistoryDir is the single source of truth for a session's file-history
// directory layout.
func FileHistoryDir(sessionID string) (string, error) {
	return storage.SessionPath(sessionID, FileHistoryDirName)
}

func filePathHash(filePath string) string {
	sum := sha256.Sum256([]byte(filePath))
	return fmt.Sprintf("%x", sum[:])[:16]
}

func getBackupName(filePath string, snapshotIndex int) string {
	return fmt.Sprintf("%s@s%d", filePathHash(filePath), snapshotIndex)
}

func getBaselineBackupName(filePath string) string {
	return filePathHash(filePath) + "@baseline"
}

func isoNow() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000") + "Z"
}

// History mirrors FileHistory: every operation reloads the persisted state
// under the file lock, so concurrent processes observe each other.
type History struct {
	sessionDir string
	statePath  string

	trackedFiles    map[string]bool
	baselines       map[string]FileBaseline
	snapshots       []Snapshot
	nextSnapshotSeq int
}

// New mirrors the reference constructor: an invalid session ID throws, so
// callers never receive a half-initialized history.
func New(sessionID string) *History {
	dir, err := FileHistoryDir(sessionID)
	if err != nil {
		panic(err)
	}
	if err := storage.MkdirPrivateSync(dir); err != nil {
		panic(err)
	}
	h := &History{
		sessionDir: dir,
		statePath:  filepath.Join(dir, SnapshotsFileName),
	}
	_ = storage.WithFileSyncLock(h.statePath, func() error {
		h.loadUnlocked()
		return nil
	})
	return h
}

// TrackEdit registers a file immediately before its first edit. Its original
// content, absence, or an unavailable read is captured once so rewind can
// safely cross the point where tracking began.
func (h *History) TrackEdit(path string) {
	_ = storage.WithFileSyncLock(h.statePath, func() error {
		h.loadUnlocked()
		filePath := path
		if abs, err := filepath.Abs(path); err == nil {
			filePath = abs
		}
		if !h.trackedFiles[filePath] {
			h.baselines[filePath] = h.captureBaseline(filePath)
			h.trackedFiles[filePath] = true
		}
		h.saveUnlocked()
		return nil
	})
}

func (h *History) captureBaseline(filePath string) FileBaseline {
	content, err := os.ReadFile(filePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return FileBaseline{State: "absent"}
		}
		return FileBaseline{State: "unavailable"}
	}
	backupPath := filepath.Join(h.sessionDir, getBaselineBackupName(filePath))
	if err := storage.WritePrivateFileSync(backupPath, content, os.O_WRONLY|os.O_CREATE|os.O_TRUNC); err != nil {
		log.Error(map[string]any{"err": err}, "file-history baseline capture failed")
		return FileBaseline{State: "unavailable"}
	}
	return FileBaseline{State: "existing", BackupPath: backupPath}
}

// MakeSnapshot captures the current content of every tracked file as a
// checkpoint. sessionLineCount records the session-log coordinate of this
// moment so /rewind can truncate the session file exactly.
func (h *History) MakeSnapshot(messageIndex int, userText string, sessionLineCount *int) {
	_ = storage.WithFileSyncLock(h.statePath, func() error {
		h.loadUnlocked()
		text := userText
		if runes := []rune(text); len(runes) > MaxSummaryTextLength {
			text = string(runes[:MaxSummaryTextLength]) + "..."
		}
		now := isoNow()
		snapshotIndex := h.nextSnapshotSeq
		h.nextSnapshotSeq++
		backups := make(map[string]Backup, len(h.trackedFiles))
		for filePath := range h.trackedFiles {
			backupPath := filepath.Join(h.sessionDir, getBackupName(filePath, snapshotIndex))
			if _, err := os.Stat(filePath); err != nil {
				backups[filePath] = Backup{State: "absent", Time: now}
				continue
			}
			data, err := os.ReadFile(filePath)
			if err != nil {
				log.Error(map[string]any{"err": err}, "file-history operation failed")
				backups[filePath] = Backup{State: "unavailable", Time: now}
				continue
			}
			if err := storage.WritePrivateFileSync(backupPath, data, os.O_WRONLY|os.O_CREATE|os.O_TRUNC); err != nil {
				log.Error(map[string]any{"err": err}, "file-history operation failed")
				backups[filePath] = Backup{State: "unavailable", Time: now}
				continue
			}
			backups[filePath] = Backup{State: "existing", BackupPath: backupPath, Time: now}
		}
		snapshot := Snapshot{
			ID:               uuid.NewString(),
			MessageIndex:     messageIndex,
			UserText:         text,
			Backups:          backups,
			Timestamp:        now,
			SessionLineCount: sessionLineCount,
		}
		h.snapshots = append(h.snapshots, snapshot)

		if len(h.snapshots) > MaxSnapshots {
			pruned := h.snapshots[:len(h.snapshots)-MaxSnapshots]
			h.snapshots = h.snapshots[len(h.snapshots)-MaxSnapshots:]
			h.deleteBackups(pruned)
		}
		h.saveUnlocked()
		return nil
	})
}

// Rewind restores the file state recorded at snapshotIndex.
func (h *History) Rewind(snapshotIndex int) ([]string, error) {
	var changed []string
	err := storage.WithFileSyncLock(h.statePath, func() error {
		h.loadUnlocked()
		var rewindErr error
		changed, rewindErr = h.rewindUnlocked(snapshotIndex)
		return rewindErr
	})
	if err != nil {
		return nil, err
	}
	return changed, nil
}

func (h *History) rewindUnlocked(snapshotIndex int) ([]string, error) {
	if snapshotIndex < 0 || snapshotIndex >= len(h.snapshots) {
		return nil, fmt.Errorf("Invalid snapshot index: %d", snapshotIndex)
	}
	target := h.snapshots[snapshotIndex]
	var changed []string
	for filePath, backup := range target.Backups {
		switch backup.State {
		case "unavailable":
			continue
		case "absent":
			if _, err := os.Stat(filePath); err == nil {
				if rmErr := os.Remove(filePath); rmErr != nil {
					log.Error(map[string]any{"err": rmErr}, "file-history operation failed")
				} else {
					changed = append(changed, filePath)
				}
			}
			continue
		}
		backupData, err := storage.ReadPrivateFileSync(backup.BackupPath)
		if err != nil {
			log.Error(map[string]any{"err": err}, "file-history backup read failed")
			continue
		}
		currentData, err := os.ReadFile(filePath)
		if err != nil {
			// File doesn't exist now but backup exists -> restore.
			log.Error(map[string]any{"err": err}, "file-history operation failed")
			currentData = nil
		}
		if !bytes.Equal(backupData, currentData) {
			if err := os.MkdirAll(filepath.Dir(filePath), 0o755); err == nil {
				if writeErr := os.WriteFile(filePath, backupData, 0o644); writeErr == nil {
					changed = append(changed, filePath)
				} else {
					log.Error(map[string]any{"err": writeErr}, "file-history operation failed")
				}
			}
		}
	}

	// Files first tracked after target have no snapshot entry. Restore their
	// first-track baseline: pre-existing files regain their original content,
	// truly new files are removed, and unavailable baselines are left
	// untouched.
	unresolvedBaselines := map[string]bool{}
	for filePath := range h.trackedFiles {
		if _, ok := target.Backups[filePath]; ok {
			continue
		}
		baseline := h.baselines[filePath]
		resolved := false
		switch baseline.State {
		case "existing":
			baselineData, err := storage.ReadPrivateFileSync(baseline.BackupPath)
			if err == nil {
				currentData, err := os.ReadFile(filePath)
				if err != nil {
					currentData = nil
				}
				if !bytes.Equal(baselineData, currentData) {
					if mkErr := os.MkdirAll(filepath.Dir(filePath), 0o755); mkErr == nil {
						if writeErr := os.WriteFile(filePath, baselineData, 0o644); writeErr == nil {
							changed = append(changed, filePath)
						}
					}
				}
				resolved = true
			} else {
				log.Error(map[string]any{"err": err}, "file-history baseline restore failed")
			}
			if resolved {
				_ = os.Remove(baseline.BackupPath)
			}
		case "absent":
			if _, err := os.Stat(filePath); err != nil {
				resolved = true
			} else if rmErr := os.Remove(filePath); rmErr == nil {
				changed = append(changed, filePath)
				resolved = true
			} else {
				log.Error(map[string]any{"err": rmErr}, "file-history baseline delete failed")
			}
		}
		if resolved {
			delete(h.baselines, filePath)
		} else {
			// Keep both the first-track state and tracking membership so a
			// later rewind can retry after the transient failure clears.
			unresolvedBaselines[filePath] = true
		}
	}

	// Truncate snapshot history -- can't redo forward. The removed snapshots
	// can no longer be reached: delete their backups from disk too.
	removed := h.snapshots[snapshotIndex+1:]
	h.deleteBackups(removed)
	h.snapshots = h.snapshots[:snapshotIndex+1]
	tracked := make(map[string]bool, len(target.Backups)+len(unresolvedBaselines))
	for filePath := range target.Backups {
		tracked[filePath] = true
	}
	for filePath := range unresolvedBaselines {
		tracked[filePath] = true
	}
	h.trackedFiles = tracked
	h.saveUnlocked()
	return changed, nil
}

// deleteBackups removes the backup files owned by the given snapshots
// best-effort.
func (h *History) deleteBackups(snapshots []Snapshot) {
	for _, snapshot := range snapshots {
		for _, backup := range snapshot.Backups {
			if backup.State != "existing" {
				continue
			}
			_ = os.Remove(backup.BackupPath)
		}
	}
}

func (h *History) GetSnapshots() []Snapshot {
	var out []Snapshot
	_ = storage.WithFileSyncLock(h.statePath, func() error {
		h.loadUnlocked()
		out = append([]Snapshot(nil), h.snapshots...)
		return nil
	})
	return out
}

func (h *History) HasSnapshots() bool {
	has := false
	_ = storage.WithFileSyncLock(h.statePath, func() error {
		h.loadUnlocked()
		has = len(h.snapshots) > 0
		return nil
	})
	return has
}

func (h *History) saveUnlocked() {
	state := PersistedState{
		Version:         PersistedStateVersion,
		TrackedFiles:    make([]string, 0, len(h.trackedFiles)),
		Snapshots:       h.snapshots,
		Baselines:       h.baselines,
		NextSnapshotSeq: h.nextSnapshotSeq,
	}
	for filePath := range h.trackedFiles {
		state.TrackedFiles = append(state.TrackedFiles, filePath)
	}
	encoded, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		log.Error(map[string]any{"err": err}, "file-history operation failed")
		return
	}
	temporary := fmt.Sprintf("%s.%d.tmp", h.statePath, os.Getpid())
	if err := storage.WritePrivateFileSync(temporary, encoded, os.O_WRONLY|os.O_CREATE|os.O_TRUNC); err != nil {
		log.Error(map[string]any{"err": err}, "file-history operation failed")
		_ = os.Remove(temporary)
		return
	}
	if err := os.Rename(temporary, h.statePath); err != nil {
		log.Error(map[string]any{"err": err}, "file-history operation failed")
		_ = os.Remove(temporary)
	}
}

func (h *History) loadUnlocked() {
	h.trackedFiles = map[string]bool{}
	h.baselines = map[string]FileBaseline{}
	h.snapshots = nil
	h.nextSnapshotSeq = 0
	if _, err := os.Stat(h.statePath); err != nil {
		return
	}
	raw, err := storage.ReadPrivateFileSync(h.statePath)
	if err != nil {
		log.Error(map[string]any{"err": err}, "file-history operation failed")
		return
	}
	var state PersistedState
	if err := json.Unmarshal(raw, &state); err != nil {
		log.Error(map[string]any{"err": err}, "file-history operation failed")
		return
	}
	if state.Version != PersistedStateVersion {
		log.Error(map[string]any{"version": state.Version}, "file-history operation failed")
		return
	}
	for _, snapshot := range state.Snapshots {
		if snapshot.ID == "" || snapshot.UserText == "" && snapshot.Backups == nil || snapshot.Timestamp == "" || snapshot.Backups == nil {
			log.Error(nil, "file-history operation failed")
			return
		}
		for _, backup := range snapshot.Backups {
			switch backup.State {
			case "existing", "absent", "unavailable":
			default:
				log.Error(nil, "file-history operation failed")
				return
			}
		}
	}
	h.snapshots = state.Snapshots
	h.nextSnapshotSeq = state.NextSnapshotSeq
	for filePath, baseline := range state.Baselines {
		switch baseline.State {
		case "existing", "absent", "unavailable":
			h.baselines[filePath] = baseline
		default:
			log.Error(nil, "file-history operation failed")
			return
		}
	}
	if len(state.TrackedFiles) > 0 {
		for _, filePath := range state.TrackedFiles {
			h.trackedFiles[filePath] = true
		}
	} else if len(state.Snapshots) > 0 {
		// Rebuild tracking from the newest snapshot so post-resume edits of
		// already-tracked files keep landing in new snapshots.
		last := state.Snapshots[len(state.Snapshots)-1]
		for filePath := range last.Backups {
			h.trackedFiles[filePath] = true
		}
	}
}
