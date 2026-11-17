package sandbox

import "sync"

type Runtime struct {
	mu          sync.Mutex
	initialized bool
	instance    Sandbox
}

func (r *Runtime) Get() Sandbox {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.initialized {
		r.instance, r.initialized = New(), true
	}
	return r.instance
}

func (r *Runtime) Reset() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.instance, r.initialized = nil, false
}
