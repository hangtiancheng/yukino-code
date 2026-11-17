package a2a

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"iter"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/a2aproject/a2a-go/a2asrv"
	"github.com/google/uuid"

	a2alib "github.com/a2aproject/a2a-go/a2a"

	"github.com/yukino-js/yukino/yukino/internal/agent"
	"github.com/yukino-js/yukino/yukino/internal/session"
	"github.com/yukino-js/yukino/yukino/internal/storage"
)

type PendingPermission struct {
	Data    PermissionRequestData
	resolve func(PermissionDecision)
}

type settleSignal struct {
	ch   chan struct{}
	once sync.Once
}

func newSettleSignal() *settleSignal { return &settleSignal{ch: make(chan struct{})} }

func (s *settleSignal) resolve() { s.once.Do(func() { close(s.ch) }) }

// ActiveRun tracks one in-flight agent run for a session.
type ActiveRun struct {
	TaskID    a2alib.TaskID
	contextID string
	Runtime   Runtime

	bus    chan a2alib.Event
	done   chan struct{}
	mu     sync.Mutex
	settle *settleSignal

	canceled   bool
	finished   bool
	stopReason string
	text       string
	messageID  string
	lastAnswer *a2alib.Message

	permissions map[string]*PendingPermission
}

func (r *ActiveRun) isFinished() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.finished
}

func (r *ActiveRun) publish(event a2alib.Event) {
	r.bus <- event
}

func (r *ActiveRun) resolveSettle() {
	r.mu.Lock()
	settle := r.settle
	r.mu.Unlock()
	settle.resolve()
}

type a2aSession struct {
	contextID string
	// Persisted across eviction so a recreated runtime restores the
	// transcript.
	sessionID string

	mu           sync.Mutex
	runtime      Runtime
	initializing bool
	run          *ActiveRun
	idleTimer    *time.Timer
}

func (s *a2aSession) currentRun() *ActiveRun {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.run
}

// Executor bridges the A2A protocol to the yukino agent loop. One runtime
// session is kept per A2A contextId; each SendMessage turn runs the agent
// until it completes, fails, or needs a tool permission decision. Permission
// requests surface as INPUT_REQUIRED status updates carrying a yukino
// permission-request data part; the client answers by sending a
// permission-response data part back on the same task.
//
// Runtimes are created lazily (only for a valid, non-busy turn) and disposed
// after the idle timeout without activity; the next message recreates the
// runtime and restores the persisted transcript, so eviction is transparent
// to the conversation while reclaiming MCP connections and background
// managers.
type Executor struct {
	mu                sync.Mutex
	sessions          map[string]*a2aSession
	recency           map[string]int64
	accessCounter     int64
	permissionCounter int

	runtimeFactory RuntimeFactory
	cwd            string
	idleTimeout    time.Duration
}

var _ a2asrv.AgentExecutor = (*Executor)(nil)

func NewExecutor(runtimeFactory RuntimeFactory, cwd string, idleTimeout time.Duration) *Executor {
	if runtimeFactory == nil {
		runtimeFactory = CreateA2aRuntime
	}
	if idleTimeout <= 0 {
		idleTimeout = DefaultIdleTimeout
	}
	return &Executor{
		sessions:       map[string]*a2aSession{},
		recency:        map[string]int64{},
		runtimeFactory: runtimeFactory,
		cwd:            cwd,
		idleTimeout:    idleTimeout,
	}
}

func (e *Executor) getSession(contextID string) *a2aSession {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.sessions[contextID]
}

func (e *Executor) touch(contextID string) {
	e.accessCounter++
	e.recency[contextID] = e.accessCounter
}

// Execute implements a2asrv.AgentExecutor.
func (e *Executor) Execute(ctx context.Context, execCtx *a2asrv.ExecutorContext) iter.Seq2[a2alib.Event, error] {
	return func(yield func(a2alib.Event, error) bool) {
		taskID := execCtx.TaskID
		contextID := execCtx.ContextID
		message := execCtx.Message
		if message == nil {
			return
		}

		// Disarm eviction for the duration of this turn so the runtime cannot
		// be disposed mid-processing; the deferred re-arm fires once idle.
		e.disarmIdleTimer(e.getSession(contextID))
		defer func() {
			if session := e.getSession(contextID); session != nil {
				e.armIdleTimer(session)
			}
		}()

		if response := FindPermissionResponse(message); response != nil {
			session := e.getSession(contextID)
			if session == nil {
				e.reject(nil, yield, taskID, contextID, NoActiveRun)
				return
			}
			e.handlePermissionResponse(session, taskID, contextID, response, yield)
			return
		}

		text := MessageText(message)
		if text == "" {
			// Reject without touching the session map: an invalid message must
			// not create a session or spin up a runtime for a fresh contextId.
			e.reject(e.getSession(contextID), yield, taskID, contextID, MessageContentRequired)
			return
		}

		existing := e.getSession(contextID)
		if existing != nil {
			if run := existing.currentRun(); run != nil && !run.isFinished() {
				e.reject(existing, yield, taskID, contextID, BuildContextBusyReason(contextID, string(run.TaskID)))
				return
			}
		}

		var session *a2aSession
		if existing != nil {
			session = existing
			e.mu.Lock()
			e.touch(contextID)
			e.mu.Unlock()
		} else {
			created, err := e.createSession(contextID)
			if err != nil {
				e.reject(nil, yield, taskID, contextID, err.Error())
				return
			}
			session = created
		}

		runtime, err := e.ensureRuntime(session)
		if err != nil {
			e.reject(session, yield, taskID, contextID, err.Error())
			return
		}
		if e.getSession(contextID) != session {
			e.reject(nil, yield, taskID, contextID, SessionClosedDuringInit)
			return
		}
		if active := session.currentRun(); active != nil && !active.isFinished() {
			e.reject(session, yield, taskID, contextID, BuildContextBusyReason(contextID, string(active.TaskID)))
			return
		}

		run := e.startRun(session, runtime, taskID, contextID, text, yield)
		e.consume(session, run, text)
		e.attach(run, yield)
	}
}

// Cancel implements a2asrv.AgentExecutor.
func (e *Executor) Cancel(ctx context.Context, execCtx *a2asrv.ExecutorContext) iter.Seq2[a2alib.Event, error] {
	return func(yield func(a2alib.Event, error) bool) {
		taskID := execCtx.TaskID
		session, run := e.findSessionByTask(taskID)
		if session == nil || run == nil || run.isFinished() {
			// No live run (e.g. the bus outlived its consumer): emit the
			// terminal state directly so the cancellation request still
			// settles.
			contextID := execCtx.ContextID
			if session != nil && contextID == "" {
				contextID = session.contextID
			}
			yield(StatusUpdate(taskID, contextID, a2alib.TaskStateCanceled,
				AgentMessage(taskID, contextID, TextPart(TaskCanceledText))), nil)
			return
		}

		e.disarmIdleTimer(session)
		run.mu.Lock()
		run.canceled = true
		pending := run.permissions
		run.permissions = map[string]*PendingPermission{}
		run.mu.Unlock()
		for _, p := range pending {
			p.resolve(DecisionDeny)
		}
		run.Runtime.Abort()
		e.attachUntilDone(run, yield)
	}
}

// Dispose aborts every session, clears idle timers, and disposes the
// runtimes.
func (e *Executor) Dispose() {
	e.mu.Lock()
	sessions := make([]*a2aSession, 0, len(e.sessions))
	for _, session := range e.sessions {
		sessions = append(sessions, session)
	}
	e.sessions = map[string]*a2aSession{}
	e.recency = map[string]int64{}
	e.mu.Unlock()

	var wg sync.WaitGroup
	for _, session := range sessions {
		e.disarmIdleTimer(session)
		session.mu.Lock()
		runtime := session.runtime
		session.runtime = nil
		run := session.run
		session.mu.Unlock()
		if runtime == nil {
			continue
		}
		if run != nil && !run.isFinished() {
			run.mu.Lock()
			run.canceled = true
			pending := run.permissions
			run.permissions = map[string]*PendingPermission{}
			run.mu.Unlock()
			for _, p := range pending {
				p.resolve(DecisionDeny)
			}
			runtime.Abort()
		}
		wg.Add(1)
		go func(rt Runtime) {
			defer wg.Done()
			_ = rt.Dispose()
		}(runtime)
	}
	wg.Wait()
}

func (e *Executor) createSession(contextID string) (*a2aSession, error) {
	e.evictOverflowSessions()
	e.mu.Lock()
	if len(e.sessions) >= MaxTrackedSessions {
		e.mu.Unlock()
		return nil, errors.New(SessionCapacityError)
	}
	e.mu.Unlock()

	mappingPath, err := e.contextMappingPath(contextID)
	if err != nil {
		return nil, err
	}
	var sessionID string
	if data, err := storage.ReadPrivateFileSync(mappingPath); err == nil {
		sessionID = string(data)
	}
	if sessionID != "" && !storage.SessionIDRe.MatchString(sessionID) {
		return nil, errors.New(InvalidContextMappingError)
	}
	session := &a2aSession{contextID: contextID, sessionID: sessionID}
	e.mu.Lock()
	e.sessions[contextID] = session
	e.touch(contextID)
	e.mu.Unlock()
	return session, nil
}

func (e *Executor) contextMappingPath(contextID string) (string, error) {
	sum := sha256.Sum256([]byte(contextID))
	return storage.ProjectPath(e.cwd, A2AContextsDirName, hex.EncodeToString(sum[:]))
}

// evictOverflowSessions bounds the tracked-session map by dropping the
// least-recently-used fully-idle sessions. A session with an in-flight or
// permission-pending run is never evicted. The dropped session's persisted
// transcript stays on disk; only the in-memory contextId→sessionId link is
// released after an atomic disk checkpoint.
func (e *Executor) evictOverflowSessions() {
	e.mu.Lock()
	if len(e.sessions) < MaxTrackedSessions {
		e.mu.Unlock()
		return
	}
	type candidate struct {
		id      string
		session *a2aSession
		access  int64
	}
	var candidates []candidate
	for id, session := range e.sessions {
		session.mu.Lock()
		busy := (session.run != nil && !session.run.finished) || session.initializing
		session.mu.Unlock()
		if busy {
			continue
		}
		candidates = append(candidates, candidate{id, session, e.recency[id]})
	}
	e.mu.Unlock()

	sort.Slice(candidates, func(i, j int) bool { return candidates[i].access < candidates[j].access })
	for _, c := range candidates {
		e.mu.Lock()
		if len(e.sessions) < MaxTrackedSessions {
			e.mu.Unlock()
			return
		}
		delete(e.sessions, c.id)
		delete(e.recency, c.id)
		e.mu.Unlock()

		c.session.mu.Lock()
		sessionID := c.session.sessionID
		runtime := c.session.runtime
		c.session.runtime = nil
		c.session.mu.Unlock()
		if sessionID != "" {
			e.persistContextMapping(c.id, sessionID)
		}
		e.disarmIdleTimer(c.session)
		if runtime != nil {
			_ = runtime.Dispose()
		}
	}
}

func (e *Executor) persistContextMapping(contextID, sessionID string) {
	path, err := e.contextMappingPath(contextID)
	if err != nil {
		return
	}
	if err := storage.MkdirPrivateSync(filepath.Dir(path)); err != nil {
		return
	}
	_ = storage.WithFileSyncLock(path, func() error {
		temporary := fmt.Sprintf("%s.%s.tmp", path, uuid.NewString())
		file, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, storage.PrivateFileMode)
		if err != nil {
			return err
		}
		if _, err := file.WriteString(sessionID); err != nil {
			_ = file.Close()
			_ = os.Remove(temporary)
			return err
		}
		if err := file.Close(); err != nil {
			_ = os.Remove(temporary)
			return err
		}
		if err := os.Rename(temporary, path); err != nil {
			_ = os.Remove(temporary)
			return err
		}
		return nil
	})
}

// ensureRuntime returns the session's runtime, creating (or recreating after
// eviction) it lazily. A recreation passes the persisted sessionId so the
// factory restores the transcript. On failure the slot stays clear so a later
// message retries.
func (e *Executor) ensureRuntime(session *a2aSession) (Runtime, error) {
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.runtime != nil {
		return session.runtime, nil
	}
	session.initializing = true
	runtime, err := e.runtimeFactory(e.cwd, session.sessionID)
	session.initializing = false
	if err != nil {
		return nil, err
	}
	session.sessionID = runtime.SessionID()
	session.runtime = runtime
	return runtime, nil
}

func (e *Executor) armIdleTimer(session *a2aSession) {
	if session == nil {
		return
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.idleTimer != nil {
		session.idleTimer.Stop()
		session.idleTimer = nil
	}
	if e.idleTimeout <= 0 || session.runtime == nil {
		return
	}
	if session.run != nil && !session.run.finished {
		return
	}
	session.idleTimer = time.AfterFunc(e.idleTimeout, func() {
		session.mu.Lock()
		session.idleTimer = nil
		session.mu.Unlock()
		e.evictSession(session)
	})
}

func (e *Executor) disarmIdleTimer(session *a2aSession) {
	if session == nil {
		return
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.idleTimer != nil {
		session.idleTimer.Stop()
		session.idleTimer = nil
	}
}

// evictSession disposes an idle session's runtime to reclaim resources,
// keeping the contextId→sessionId mapping so the next message restores the
// transcript. Never evicts a session with an in-flight or permission-pending
// run.
func (e *Executor) evictSession(session *a2aSession) {
	session.mu.Lock()
	if session.run != nil && !session.run.finished {
		session.mu.Unlock()
		return
	}
	runtime := session.runtime
	session.runtime = nil
	session.mu.Unlock()
	if runtime != nil {
		_ = runtime.Dispose()
	}
}

func (e *Executor) findSessionByTask(taskID a2alib.TaskID) (*a2aSession, *ActiveRun) {
	e.mu.Lock()
	sessions := make([]*a2aSession, 0, len(e.sessions))
	for _, session := range e.sessions {
		sessions = append(sessions, session)
	}
	e.mu.Unlock()
	for _, session := range sessions {
		if run := session.currentRun(); run != nil && run.TaskID == taskID {
			return session, run
		}
	}
	return nil, nil
}

func (e *Executor) handlePermissionResponse(session *a2aSession, taskID a2alib.TaskID, contextID string, response *PermissionResponseData, yield func(a2alib.Event, error) bool) {
	run := session.currentRun()
	if run == nil || run.isFinished() {
		e.reject(session, yield, taskID, contextID, NoActiveRun)
		return
	}
	if run.TaskID != taskID {
		e.reject(session, yield, taskID, contextID, BuildPermissionTaskMismatchReason(string(run.TaskID)))
		return
	}
	run.mu.Lock()
	pending := run.permissions[response.PermissionID]
	if pending == nil {
		run.mu.Unlock()
		e.reject(session, yield, taskID, contextID, BuildUnknownPermissionIDReason(response.PermissionID))
		return
	}
	delete(run.permissions, response.PermissionID)
	run.settle = newSettleSignal()
	remaining := len(run.permissions)
	run.mu.Unlock()

	if !yield(TaskSnapshot(taskID, contextID, a2alib.TaskStateWorking, nil), nil) {
		return
	}
	pending.resolve(response.Decision)
	if remaining > 0 {
		e.publishPendingPermissions(run)
		run.resolveSettle()
	}
	e.attach(run, yield)
}

func (e *Executor) startRun(session *a2aSession, runtime Runtime, taskID a2alib.TaskID, contextID, text string, yield func(a2alib.Event, error) bool) *ActiveRun {
	e.disarmIdleTimer(session)
	run := &ActiveRun{
		TaskID:      taskID,
		contextID:   contextID,
		Runtime:     runtime,
		bus:         make(chan a2alib.Event, 4096),
		settle:      newSettleSignal(),
		done:        make(chan struct{}),
		messageID:   uuid.NewString(),
		permissions: map[string]*PendingPermission{},
	}
	session.mu.Lock()
	session.run = run
	session.mu.Unlock()
	_ = sessionSaveUserMessage(runtime.Cwd(), runtime.SessionID(), text)
	yield(TaskSnapshot(taskID, contextID, a2alib.TaskStateSubmitted, nil), nil)
	return run
}

// consume drives the runtime event stream in a background goroutine,
// publishing A2A events to the run bus until the run finishes.
func (e *Executor) consume(session *a2aSession, run *ActiveRun, text string) {
	go func() {
		var failure string
		events, err := run.Runtime.Run(text)
		if err != nil {
			failure = err.Error()
		} else {
			for event := range events {
				switch ev := event.(type) {
				case agent.LoopComplete:
					run.mu.Lock()
					run.stopReason = ev.StopReason
					run.mu.Unlock()
				case agent.ErrorEvent:
					failure = ev.Message
				case agent.PermissionRequestEvent:
					go func(request agent.PermissionRequestEvent) {
						reply := e.requestPermission(run, request)
						request.ResponseCh <- reply
					}(ev)
					continue
				}
				e.publishAgentEvent(run, event)
			}
		}
		e.finishRun(session, run, failure)
	}()
}

// requestPermission surfaces a tool permission decision through the A2A
// handshake and blocks until the client answers, the run is canceled, or the
// run finishes.
func (e *Executor) requestPermission(run *ActiveRun, request agent.PermissionRequestEvent) agent.PermissionReply {
	if request.Context != nil && request.Context.Err() != nil {
		return agent.PermissionReply{Response: agent.PermDeny}
	}
	run.mu.Lock()
	if run.canceled || run.finished {
		run.mu.Unlock()
		return agent.PermissionReply{Response: agent.PermDeny}
	}
	run.mu.Unlock()

	e.mu.Lock()
	e.permissionCounter++
	permissionID := fmt.Sprintf("perm-%d-%s", e.permissionCounter, uuid.NewString()[:8])
	e.mu.Unlock()

	data := PermissionRequestData{
		Yukino:       PermissionRequestKind,
		PermissionID: permissionID,
		ToolCallID:   request.ToolID,
		ToolName:     request.ToolName,
		Reason:       request.Decision.Reason,
		Args:         request.Args,
	}
	if request.AgentName != "" || request.Cwd != "" {
		data.Source = &PermissionSource{AgentName: request.AgentName, Cwd: request.Cwd}
	}
	decisionCh := make(chan PermissionDecision, 1)
	pending := &PendingPermission{
		Data: data,
		resolve: func(decision PermissionDecision) {
			select {
			case decisionCh <- decision:
			default:
			}
		},
	}
	run.mu.Lock()
	run.permissions[permissionID] = pending
	run.mu.Unlock()

	e.publishPendingPermissions(run)
	run.resolveSettle()
	return toPermissionReply(<-decisionCh)
}

func toPermissionReply(decision PermissionDecision) agent.PermissionReply {
	switch decision {
	case DecisionAllow:
		return agent.PermissionReply{Response: agent.PermAllow}
	case DecisionAllowAlways:
		return agent.PermissionReply{Response: agent.PermAllowAlways}
	default:
		return agent.PermissionReply{Response: agent.PermDeny}
	}
}

func (e *Executor) publishPendingPermissions(run *ActiveRun) {
	run.mu.Lock()
	ids := make([]string, 0, len(run.permissions))
	for id := range run.permissions {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	parts := make([]*a2alib.Part, 0, len(ids))
	for _, id := range ids {
		parts = append(parts, DataPart(run.permissions[id].Data))
	}
	run.mu.Unlock()
	run.publish(StatusUpdate(run.TaskID, run.contextID, a2alib.TaskStateInputRequired,
		AgentMessage(run.TaskID, run.contextID, parts...)))
}

func (e *Executor) publishAgentEvent(run *ActiveRun, event agent.AgentEvent) {
	if _, ok := event.(agent.TurnComplete); ok {
		e.flushAnswer(run)
		return
	}
	message := AgentEventToMessage(event, run.TaskID, run.contextID)
	if message == nil {
		return
	}
	if streamText, ok := event.(agent.StreamText); ok {
		if streamText.Text == "" {
			return
		}
		run.mu.Lock()
		append := run.text != ""
		run.text += streamText.Text
		messageID := run.messageID
		run.mu.Unlock()
		run.publish(&a2alib.TaskArtifactUpdateEvent{
			TaskID:    run.TaskID,
			ContextID: run.contextID,
			Artifact: &a2alib.Artifact{
				ID:    a2alib.ArtifactID(messageID),
				Parts: []*a2alib.Part{TextPart(streamText.Text)},
			},
			Append:    append,
			LastChunk: false,
		})
		return
	}
	update := StatusUpdate(run.TaskID, run.contextID, a2alib.TaskStateWorking, nil)
	if len(message.Parts) > 0 && message.Parts[0] != nil {
		switch content := message.Parts[0].Content.(type) {
		case a2alib.Data:
			update.Metadata = map[string]any{YukinoDataKey: content.Value}
		case a2alib.Text:
			update.Metadata = map[string]any{YukinoDataKey: string(content)}
		}
	}
	run.publish(update)
}

func (e *Executor) flushAnswer(run *ActiveRun) {
	run.mu.Lock()
	if run.text == "" {
		run.mu.Unlock()
		return
	}
	text := run.text
	messageID := run.messageID
	message := AgentMessage(run.TaskID, run.contextID, TextPart(text))
	message.ID = messageID
	run.lastAnswer = message
	run.text = ""
	run.messageID = uuid.NewString()
	run.mu.Unlock()

	run.publish(&a2alib.TaskArtifactUpdateEvent{
		TaskID:    run.TaskID,
		ContextID: run.contextID,
		Artifact: &a2alib.Artifact{
			ID:    a2alib.ArtifactID(messageID),
			Parts: []*a2alib.Part{TextPart(text)},
		},
		Append:    false,
		LastChunk: true,
	})
	run.publish(StatusUpdate(run.TaskID, run.contextID, a2alib.TaskStateWorking, message))
}

func (e *Executor) finishRun(session *a2aSession, run *ActiveRun, failure string) {
	run.mu.Lock()
	if run.finished {
		run.mu.Unlock()
		return
	}
	run.finished = true
	pending := run.permissions
	run.permissions = map[string]*PendingPermission{}
	run.mu.Unlock()
	for _, p := range pending {
		p.resolve(DecisionDeny)
	}

	e.flushAnswer(run)
	state := e.finalState(run, failure)
	var message *a2alib.Message
	if failure != "" {
		message = AgentMessage(run.TaskID, run.contextID, TextPart(failure))
	} else {
		run.mu.Lock()
		message = run.lastAnswer
		run.mu.Unlock()
	}
	run.publish(StatusUpdate(run.TaskID, run.contextID, state, message))

	session.mu.Lock()
	if session.run == run {
		session.run = nil
	}
	session.mu.Unlock()
	run.resolveSettle()
	close(run.done)
	// The run reached a terminal state, so the session is now idle.
	e.armIdleTimer(session)
}

func (e *Executor) finalState(run *ActiveRun, failure string) a2alib.TaskState {
	run.mu.Lock()
	canceled := run.canceled
	stopReason := run.stopReason
	run.mu.Unlock()
	if canceled || stopReason == "cancelled" || stopReason == "interrupted" {
		return a2alib.TaskStateCanceled
	}
	if failure != "" {
		return a2alib.TaskStateFailed
	}
	return a2alib.TaskStateCompleted
}

// reject rejects a request. While a run is active the rejection is published
// as a standalone Message so the in-flight task's persisted state is
// untouched; otherwise the request's own task fails.
func (e *Executor) reject(session *a2aSession, yield func(a2alib.Event, error) bool, taskID a2alib.TaskID, contextID, reason string) {
	message := AgentMessage(taskID, contextID, TextPart(reason))
	if session != nil {
		if run := session.currentRun(); run != nil && !run.isFinished() {
			yield(message, nil)
			return
		}
	}
	if !yield(TaskSnapshot(taskID, contextID, a2alib.TaskStateFailed, nil), nil) {
		return
	}
	yield(StatusUpdate(taskID, contextID, a2alib.TaskStateFailed, message), nil)
}

// attachUntilDone yields the run's published events until the run finishes,
// draining any events buffered before the done signal. Cancellation waits on
// done (not settle): the run may already be settled at a permission request.
func (e *Executor) attachUntilDone(run *ActiveRun, yield func(a2alib.Event, error) bool) {
	for {
		select {
		case event := <-run.bus:
			if !yield(event, nil) {
				return
			}
		case <-run.done:
			for {
				select {
				case event := <-run.bus:
					if !yield(event, nil) {
						return
					}
				default:
					return
				}
			}
		}
	}
}

// attach yields the run's published events until the run reaches a quiescent
// point (settle), draining any events buffered before the settle signal.
func (e *Executor) attach(run *ActiveRun, yield func(a2alib.Event, error) bool) {
	for {
		run.mu.Lock()
		settle := run.settle
		run.mu.Unlock()
		select {
		case event := <-run.bus:
			if !yield(event, nil) {
				return
			}
		case <-settle.ch:
			for {
				select {
				case event := <-run.bus:
					if !yield(event, nil) {
						return
					}
				default:
					return
				}
			}
		}
	}
}

// sessionSaveUserMessage persists the raw user message before the run starts,
// mirroring the reference startRun.
func sessionSaveUserMessage(cwd, sessionID, text string) error {
	return session.SaveMessage(cwd, sessionID, session.Message{Role: "user", Content: text, Timestamp: time.Now().Unix()})
}
