package agent

import (
	"os"
	"runtime"
	"sync"
	"weak"

	"github.com/yukino-js/yukino/yukino/conversation"
	"github.com/yukino-js/yukino/yukino/session"
	"github.com/yukino-js/yukino/yukino/storage"
	"github.com/yukino-js/yukino/yukino/tools"
)

var anonymousArtifactSessions = struct {
	sync.Mutex
	ids map[weak.Pointer[conversation.Manager]]string
}{ids: make(map[weak.Pointer[conversation.Manager]]string)}

func (a *Agent) toolResultSessionID(conv *conversation.Manager) string {
	if a.SessionID != "" {
		return a.SessionID
	}
	anonymousArtifactSessions.Lock()
	defer anonymousArtifactSessions.Unlock()
	defer runtime.KeepAlive(conv)
	key := weak.Make(conv)
	if id := anonymousArtifactSessions.ids[key]; id != "" {
		return id
	}
	for key := range anonymousArtifactSessions.ids {
		if key.Value() == nil {
			delete(anonymousArtifactSessions.ids, key)
		}
	}
	id := session.NewID()
	anonymousArtifactSessions.ids[key] = id
	path, err := storage.SessionPath(id)
	if err != nil {
		panic(err)
	}
	tools.RegisterExitCleanup(func() { os.RemoveAll(path) })
	return id
}
