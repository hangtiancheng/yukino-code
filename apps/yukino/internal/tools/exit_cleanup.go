package tools

import "sync"

var exitCleanups = struct {
	sync.Mutex
	next      uint64
	callbacks map[uint64]func()
}{callbacks: make(map[uint64]func())}

func RegisterExitCleanup(callback func()) func() {
	exitCleanups.Lock()
	exitCleanups.next++
	id := exitCleanups.next
	exitCleanups.callbacks[id] = callback
	exitCleanups.Unlock()
	return func() { exitCleanups.Lock(); delete(exitCleanups.callbacks, id); exitCleanups.Unlock() }
}
func RunExitCleanups() {
	exitCleanups.Lock()
	callbacks := exitCleanups.callbacks
	exitCleanups.callbacks = make(map[uint64]func())
	exitCleanups.Unlock()
	for _, callback := range callbacks {
		func() { defer func() { recover() }(); callback() }()
	}
}
