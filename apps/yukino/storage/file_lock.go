package storage

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	lockAcquireTimeout = 5 * time.Second
	lockStale          = 10 * time.Second
	lockMinBackoff     = 5 * time.Millisecond
	lockMaxBackoff     = 80 * time.Millisecond
)

var (
	locksMu sync.Mutex
	locks   = map[string]chan struct{}{}
)

func lockChannelFor(dir string) chan struct{} {
	locksMu.Lock()
	defer locksMu.Unlock()
	ch, ok := locks[dir]
	if !ok {
		ch = make(chan struct{}, 1)
		locks[dir] = ch
	}
	return ch
}

type lockContender struct {
	choosingPath string
	ticketPath   string
	ticketName   string
}

var (
	ticketNumberRe = regexp.MustCompile(`^ticket-(\d+)-`)
	lockOwnerPidRe = regexp.MustCompile(`^(?:choosing-|ticket-\d+-)(\d+)-`)
)

func ticketNumber(entry string) int {
	match := ticketNumberRe.FindStringSubmatch(entry)
	if match == nil {
		return 0
	}
	n, _ := strconv.Atoi(match[1])
	return n
}

func lockOwnerPid(entry string) int {
	match := lockOwnerPidRe.FindStringSubmatch(entry)
	if match == nil {
		return -1
	}
	pid, err := strconv.Atoi(match[1])
	if err != nil || pid <= 0 {
		return -1
	}
	return pid
}

// ownerIdentity is the best-effort process-instance identity recorded in a
// contender file: "<pid>" or "<pid>:<startTick>".
func ownerIdentity() string {
	tick := processStartTick(os.Getpid())
	if tick == "" {
		return strconv.Itoa(os.Getpid())
	}
	return strconv.Itoa(os.Getpid()) + ":" + tick
}

func recordedStartTick(entryPath string) string {
	content, err := os.ReadFile(entryPath)
	if err != nil {
		return ""
	}
	idx := strings.Index(string(content), ":")
	if idx < 0 {
		return ""
	}
	return string(content[idx+1:])
}

func createContender(lockDir string) (*lockContender, error) {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return nil, err
	}
	id := fmt.Sprintf("%d-%s", os.Getpid(), hex.EncodeToString(buf))
	choosingPath := filepath.Join(lockDir, "choosing-"+id)
	exclusive := os.O_WRONLY | os.O_CREATE | os.O_TRUNC | os.O_EXCL
	for {
		if err := MkdirPrivateSync(lockDir); err != nil {
			return nil, err
		}
		err := WritePrivateFileSync(choosingPath, []byte(ownerIdentity()), exclusive)
		if err == nil {
			break
		}
		if !os.IsNotExist(err) {
			return nil, err
		}
	}
	entries, err := os.ReadDir(lockDir)
	if err != nil {
		os.Remove(choosingPath)
		return nil, err
	}
	maxNumber := 0
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "ticket-") {
			if n := ticketNumber(entry.Name()); n > maxNumber {
				maxNumber = n
			}
		}
	}
	ticketName := fmt.Sprintf("ticket-%016d-%s", maxNumber+1, id)
	ticketPath := filepath.Join(lockDir, ticketName)
	if err := WritePrivateFileSync(ticketPath, []byte(ownerIdentity()), exclusive); err != nil {
		os.Remove(choosingPath)
		os.Remove(ticketPath)
		return nil, err
	}
	if err := os.Remove(choosingPath); err != nil {
		os.Remove(choosingPath)
		os.Remove(ticketPath)
		return nil, err
	}
	return &lockContender{choosingPath: choosingPath, ticketPath: ticketPath, ticketName: ticketName}, nil
}

func liveLockEntries(lockDir string, contender *lockContender) (choosing []string, tickets []string, resultErr error) {
	now := time.Now()
	entries, err := os.ReadDir(lockDir)
	if err != nil {
		return nil, nil, err
	}
	for _, entry := range entries {
		entryPath := filepath.Join(lockDir, entry.Name())
		if entryPath == contender.choosingPath || entryPath == contender.ticketPath {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		ownerPid := lockOwnerPid(entry.Name())
		// A recorded start tick that no longer matches the PID's current
		// occupant proves the original owner exited and the PID was recycled —
		// reclaim it even though the liveness probe now succeeds for the
		// unrelated process.
		recorded := recordedStartTick(entryPath)
		current := ""
		if ownerPid > 0 {
			current = processStartTick(ownerPid)
		}
		pidReused := recorded != "" && current != "" && recorded != current
		ownerDead := ownerPid <= 0 || pidReused || !isProcessAlive(ownerPid)
		if now.Sub(info.ModTime()) > lockStale && ownerDead {
			os.Remove(entryPath)
		}
	}
	entries, err = os.ReadDir(lockDir)
	if err != nil {
		return nil, nil, err
	}
	for _, entry := range entries {
		switch {
		case strings.HasPrefix(entry.Name(), "choosing-"):
			choosing = append(choosing, entry.Name())
		case strings.HasPrefix(entry.Name(), "ticket-"):
			tickets = append(tickets, entry.Name())
		}
	}
	sort.Strings(tickets)
	return choosing, tickets, nil
}

func releaseTicket(lockDir string, contender *lockContender) error {
	if err := os.Remove(contender.ticketPath); err != nil && !os.IsNotExist(err) {
		return err
	}
	// Other contenders still holding tickets keep the directory alive.
	_ = os.Remove(lockDir)
	return nil
}

func acquireLock(filePath string, wait bool) (func() error, error) {
	lockDir, err := filepath.Abs(filePath + ".lock")
	if err != nil {
		return nil, err
	}
	ch := lockChannelFor(lockDir)
	deadline := time.Now().Add(lockAcquireTimeout)
	if wait {
		timer := time.NewTimer(lockAcquireTimeout)
		defer timer.Stop()
		select {
		case ch <- struct{}{}:
		case <-timer.C:
			return nil, fmt.Errorf("file lock %s: timed out after %dms", lockDir, lockAcquireTimeout.Milliseconds())
		}
	} else {
		select {
		case ch <- struct{}{}:
		default:
			return nil, nil
		}
	}

	contender, err := createContender(lockDir)
	if err != nil {
		<-ch
		return nil, err
	}
	backoff := lockMinBackoff
	for {
		choosing, tickets, err := liveLockEntries(lockDir, contender)
		if err != nil {
			_ = releaseTicket(lockDir, contender)
			<-ch
			return nil, err
		}
		if len(choosing) == 0 && len(tickets) > 0 && tickets[0] == contender.ticketName {
			var releaseMu sync.Mutex
			released := false
			return func() error {
				releaseMu.Lock()
				defer releaseMu.Unlock()
				if released {
					return nil
				}
				if err := releaseTicket(lockDir, contender); err != nil {
					return err
				}
				released = true
				<-ch
				return nil
			}, nil
		}

		if !wait || !time.Now().Before(deadline) {
			releaseErr := releaseTicket(lockDir, contender)
			<-ch
			if releaseErr != nil {
				return nil, releaseErr
			}
			if !wait {
				return nil, nil
			}
			return nil, fmt.Errorf("file lock %s: timed out after %dms", lockDir, lockAcquireTimeout.Milliseconds())
		}
		jitter, _ := rand.Int(rand.Reader, big.NewInt(int64(backoff)))
		time.Sleep(backoff + time.Duration(jitter.Int64()))
		backoff *= 2
		if backoff > lockMaxBackoff {
			backoff = lockMaxBackoff
		}
	}
}

// TryAcquireFileSyncLock returns a release function, or nil when the lock is
// held elsewhere.
func TryAcquireFileSyncLock(filePath string) (func() error, error) {
	return acquireLock(filePath, false)
}

func WithFileSyncLock(filePath string, fn func() error) (resultErr error) {
	release, err := acquireLock(filePath, true)
	if err != nil {
		return err
	}
	if release == nil {
		return fmt.Errorf("file lock %s: acquisition failed", filePath)
	}
	defer func() {
		if err := release(); err != nil {
			resultErr = err
		}
	}()
	return fn()
}
