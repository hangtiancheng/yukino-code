package teams

import "sync"

type NameRegistry struct {
	mu    sync.Mutex
	names map[string]string
}

var (
	nameRegistryOnce     sync.Once
	nameRegistryInstance *NameRegistry
)

func GetNameRegistry() *NameRegistry {
	nameRegistryOnce.Do(func() {
		nameRegistryInstance = &NameRegistry{names: make(map[string]string)}
	})
	return nameRegistryInstance
}

func (r *NameRegistry) Register(name, agentID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.names[name] = agentID
}

func (r *NameRegistry) Resolve(nameOrID string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if id, ok := r.names[nameOrID]; ok {
		return id
	}
	for _, id := range r.names {
		if id == nameOrID {
			return nameOrID
		}
	}
	return ""
}

func (r *NameRegistry) Unregister(name string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.names, name)
}

func (r *NameRegistry) Clear() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.names = make(map[string]string)
}
