package workflow

import "context"

// HostHandle is an opaque bundle identifying the host that launched the run;
// adapters unwrap it to reach their host-specific context.
type HostHandle struct {
	bundle any
}

func CreateHostHandle(bundle any) *HostHandle { return &HostHandle{bundle: bundle} }

func UnwrapHostHandle(handle *HostHandle) any {
	if handle == nil {
		return nil
	}
	return handle.bundle
}

// ProgressEmitter receives workflow progress events.
type ProgressEmitter interface {
	Emit(event ProgressEvent)
}

type progressEmitterFunc func(event ProgressEvent)

func (f progressEmitterFunc) Emit(event ProgressEvent) { f(event) }

// EmitterFunc adapts a function to ProgressEmitter.
func EmitterFunc(emit func(ProgressEvent)) ProgressEmitter { return progressEmitterFunc(emit) }

// WorkflowLogger is the warn sink used by the engine.
type WorkflowLogger interface {
	Warn(message string)
}

// WorkflowPorts bundles the host services the engine drives.
type WorkflowPorts struct {
	AgentAdapterRegistry *AgentAdapterRegistry
	ProgressEmitter      ProgressEmitter
	JournalStore         JournalStore
	Logger               WorkflowLogger
	// AgentControllers maps agentId to the cancel function of that agent.
	AgentControllers map[int]context.CancelFunc
}
