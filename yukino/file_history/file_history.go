// Copyright (c) 2026 hangtiancheng
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

package file_history

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/hangtiancheng/yukino-code/yukino/logger"
	"github.com/hangtiancheng/yukino-code/yukino/utils"
)

// log mirrors the TS module-scoped child logger
// (createChildLogger({module:"file-history"})).
var log = logger.CreateChildLogger("file-history")

const maxSnapshots = 100

// maxSummaryTextLength mirrors the TS MAX_SUMMARY_TEXT_LENGTH.
const maxSummaryTextLength = 60

type Backup struct {
	BackupPath string `json:"backupPath"`
	Version    int    `json:"version"`
	// Time is the ISO-8601 UTC string TS writes (new Date().toISOString()).
	Time string `json:"time"`
}

type Snapshot struct {
	MessageIndex int               `json:"messageIndex"`
	UserText     string            `json:"userText"`
	Backups      map[string]Backup `json:"backups"`
	Timestamp    string            `json:"timestamp"`
	// Order records the insertion order of Backups keys so Rewind iterates
	// deterministically, mirroring TS Object.entries(target.backups) over a
	// Record built from the Map-ordered trackedFiles. Not serialized: the TS
	// snapshots.json shape carries only the four fields above.
	Order []string `json:"-"`
}

// isoNow renders the current time like JS new Date().toISOString(): UTC with
// millisecond precision and a Z suffix.
func isoNow() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}

type History struct {
	mu           sync.Mutex
	sessionDir   string
	trackedFiles map[string]int // filepath → current version
	trackedOrder []string       // insertion order of trackedFiles keys (TS Map order)
	snapshots    []Snapshot
}

func New(baseDir, sessionID string) *History {
	dir := filepath.Join(baseDir, ".yukino", "file-history", sessionID)
	_ = os.MkdirAll(dir, 0o755)
	return &History{
		sessionDir:   dir,
		trackedFiles: make(map[string]int),
	}
}

func backupName(filePath string, version int) string {
	h := sha256.Sum256([]byte(filePath))
	return fmt.Sprintf("%x@v%d", h[:8], version)
}

// TrackEdit backs up the file at path before it gets modified. Call this before
// any write/edit operation. If the file doesn't exist yet (new file), no backup
// is created but the path is still tracked so Rewind can delete it.
func (h *History) TrackEdit(path string) {
	h.mu.Lock()
	defer h.mu.Unlock()

	absPath, err := filepath.Abs(path)
	if err != nil {
		absPath = path
	}

	if _, seen := h.trackedFiles[absPath]; !seen {
		h.trackedOrder = append(h.trackedOrder, absPath)
	}
	ver := h.trackedFiles[absPath]
	newVer := ver + 1

	if _, statErr := os.Stat(absPath); statErr == nil {
		data, readErr := os.ReadFile(absPath)
		if readErr == nil {
			readErr = os.WriteFile(filepath.Join(h.sessionDir, backupName(absPath, newVer)), data, 0o644)
		}
		if readErr != nil {
			log.Error("file-history operation failed", "err", readErr)
			// Skip unreadable file.
		}
	}
	// If file doesn't exist, we still bump the version so Rewind knows the file
	// didn't exist at this version (no backup file on disk → delete on rewind).

	h.trackedFiles[absPath] = newVer
}

// MakeSnapshot creates a checkpoint associated with the given conversation
// message index. userText is a short label for the UI; it is truncated here to
// the TS maximum (UTF-16 code units) rather than by the caller in bytes.
func (h *History) MakeSnapshot(msgIndex int, userText string) {
	h.mu.Lock()
	defer h.mu.Unlock()

	userText = truncateSummary(userText)
	backups := make(map[string]Backup, len(h.trackedFiles))
	order := make([]string, 0, len(h.trackedOrder))
	for _, path := range h.trackedOrder {
		ver := h.trackedFiles[path]
		bp := filepath.Join(h.sessionDir, backupName(path, ver))
		// Safety net: if the backup doesn't exist yet but the file does, create
		// it now (TS: existsSync guards around a try/catch).
		if _, err := os.Stat(bp); err != nil {
			if _, statErr := os.Stat(path); statErr == nil {
				data, readErr := os.ReadFile(path)
				if readErr == nil {
					readErr = os.WriteFile(bp, data, 0o644)
				}
				if readErr != nil {
					log.Error("file-history operation failed", "err", readErr)
				}
			}
		}
		backups[path] = Backup{BackupPath: bp, Version: ver, Time: isoNow()}
		order = append(order, path)
	}

	snap := Snapshot{
		MessageIndex: msgIndex,
		UserText:     userText,
		Backups:      backups,
		Timestamp:    isoNow(),
		Order:        order,
	}

	h.snapshots = append(h.snapshots, snap)
	if len(h.snapshots) > maxSnapshots {
		h.snapshots = h.snapshots[len(h.snapshots)-maxSnapshots:]
	}
}

// truncateSummary cuts a snapshot label to the TS maximum, counted in UTF-16
// code units and never splitting a character.
func truncateSummary(text string) string {
	if utils.UTF16Len(text) <= maxSummaryTextLength {
		return text
	}
	return utils.TruncateUTF16(text, maxSummaryTextLength) + "..."
}

// GetSnapshots returns a copy of all snapshots for UI display.
func (h *History) GetSnapshots() []Snapshot {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]Snapshot, len(h.snapshots))
	copy(out, h.snapshots)
	return out
}

// Rewind restores files to the state captured in the snapshot at the given
// index. Returns the list of files that were actually changed.
func (h *History) Rewind(snapshotIndex int) ([]string, error) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if snapshotIndex < 0 || snapshotIndex >= len(h.snapshots) {
		return nil, fmt.Errorf("Invalid snapshot index: %d", snapshotIndex)
	}

	target := h.snapshots[snapshotIndex]
	var changed []string

	// Iterate target.Order (TS: Object.entries(target.backups) over a Record
	// built from the Map-ordered trackedFiles) for a deterministic changed list.
	for _, path := range target.Order {
		backup := target.Backups[path]
		backupData, err := os.ReadFile(backup.BackupPath)
		if err != nil {
			log.Error("file-history operation failed", "err", err)
			// Backup file missing → file didn't exist at that point; delete it.
			// TS does NOT record this deletion in the changed list.
			if _, statErr := os.Stat(path); statErr == nil {
				if rmErr := os.Remove(path); rmErr != nil {
					log.Error("file-history operation failed", "err", rmErr)
				}
			}
			continue
		}

		// A file that cannot be read now (missing) always differs from the
		// backup — even when the backup is empty — and gets restored (TS:
		// currentStr is undefined in that case).
		currentData, readErr := os.ReadFile(path)
		if readErr != nil {
			log.Error("file-history operation failed", "err", readErr)
		}
		if readErr != nil || string(currentData) != string(backupData) {
			if mkErr := os.MkdirAll(filepath.Dir(path), 0o755); mkErr != nil {
				log.Error("file-history operation failed", "err", mkErr)
				continue
			}
			if writeErr := os.WriteFile(path, backupData, 0o644); writeErr != nil {
				log.Error("file-history operation failed", "err", writeErr)
				continue
			}
			changed = append(changed, path)
		}
	}

	// Files first tracked after target have no record in target.Backups, so the
	// loop above never touches them: they did not exist at that point in time, so
	// rewinding to it must delete them rather than leave them on disk.
	for _, path := range h.trackedOrder {
		if _, ok := target.Backups[path]; ok {
			continue
		}
		if _, statErr := os.Stat(path); statErr == nil {
			if rmErr := os.Remove(path); rmErr == nil {
				changed = append(changed, path)
			}
		}
	}

	// Truncate snapshots: remove everything after the target
	h.snapshots = h.snapshots[:snapshotIndex+1]

	// Reset the tracked set to the snapshot state: versions come from
	// target.Backups and the createdAfterTarget files are gone, so the surviving
	// order is exactly target.Order (TS deletes those keys, then re-sets the
	// backups' versions in entry order).
	newTracked := make(map[string]int, len(target.Order))
	for _, path := range target.Order {
		newTracked[path] = target.Backups[path].Version
	}
	h.trackedFiles = newTracked
	h.trackedOrder = append([]string(nil), target.Order...)

	return changed, nil
}

// HasSnapshots returns true if there's at least one snapshot to rewind to.
func (h *History) HasSnapshots() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.snapshots) > 0
}

// Save persists snapshot metadata to disk.
func (h *History) Save() error {
	h.mu.Lock()
	defer h.mu.Unlock()
	data, err := json.MarshalIndent(h.snapshots, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(h.sessionDir, "snapshots.json"), data, 0o644)
}
