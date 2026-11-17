package storage

import (
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestConcurrentFileLockWaitsAndReleaseIsIdempotent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state")
	release, err := TryAcquireFileSyncLock(path)
	if err != nil || release == nil {
		t.Fatalf("initial lock unavailable: %v", err)
	}
	acquired := make(chan struct{})
	done := make(chan error, 1)
	go func() { done <- WithFileSyncLock(path, func() error { close(acquired); return nil }) }()
	select {
	case <-acquired:
		t.Fatal("concurrent writer bypassed lock")
	case <-time.After(20 * time.Millisecond):
	}
	if other, err := TryAcquireFileSyncLock(path); err != nil || other != nil {
		if other != nil {
			_ = other()
		}
		t.Fatalf("try-lock bypassed holder: %v", err)
	}
	var wg sync.WaitGroup
	for range 2 {
		wg.Go(func() {
			if err := release(); err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	if err := <-done; err != nil {
		t.Fatalf("concurrent writer rejected: %v", err)
	}
}
