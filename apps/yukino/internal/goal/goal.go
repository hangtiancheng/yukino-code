package goal

import (
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf16"

	"github.com/yukino-js/yukino/yukino/internal/logger"
	"github.com/yukino-js/yukino/yukino/internal/session"
)

// maxSafeInteger mirrors Number.MAX_SAFE_INTEGER (2^53 - 1).
const maxSafeInteger = float64(1<<53 - 1)

// GoalState mirrors the reference GoalSchema. JSON keys match the TypeScript
// shape so persisted goal_state records stay interchangeable.
type GoalState struct {
	Objective            string  `json:"objective"`
	Status               string  `json:"status"`
	TokenBudget          *int64  `json:"tokenBudget"`
	TokensUsed           float64 `json:"tokensUsed"`
	TurnsExecuted        int     `json:"turnsExecuted"`
	ActiveMs             float64 `json:"activeMs"`
	BlockedAttempts      int     `json:"blockedAttempts"`
	LastBlockReason      *string `json:"lastBlockReason"`
	LastBlockedTurn      *int    `json:"lastBlockedTurn"`
	BudgetSummaryPending bool    `json:"budgetSummaryPending"`
}

var validStatus = map[string]bool{
	"active": true, "paused": true, "blocked": true,
	"complete": true, "budget_limited": true, "max_turns": true,
}

func utf16Length(s string) int { return len(utf16.Encode([]rune(s))) }

func asNumber(v any) (float64, bool) {
	f, ok := v.(float64)
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, false
	}
	return f, true
}

func isInteger(f float64) bool { return f == math.Trunc(f) }

// parseGoalState validates a decoded JSON object against the GoalSchema. It
// requires every declared key to be present (nullable keys may be null), mirroring
// zod's non-optional object schema. Unknown keys are ignored.
func parseGoalState(m map[string]any) (*GoalState, bool) {
	objRaw, ok := m["objective"]
	if !ok {
		return nil, false
	}
	objStr, ok := objRaw.(string)
	if !ok {
		return nil, false
	}
	trimmed := strings.TrimSpace(objStr)
	if utf16Length(trimmed) < 1 || utf16Length(trimmed) > MaxObjectiveChars {
		return nil, false
	}

	statusRaw, ok := m["status"]
	if !ok {
		return nil, false
	}
	status, ok := statusRaw.(string)
	if !ok || !validStatus[status] {
		return nil, false
	}

	tbRaw, ok := m["tokenBudget"]
	if !ok {
		return nil, false
	}
	var tokenBudget *int64
	if tbRaw != nil {
		f, ok := asNumber(tbRaw)
		if !ok || !isInteger(f) || f <= 0 || f > maxSafeInteger {
			return nil, false
		}
		v := int64(f)
		tokenBudget = &v
	}

	tuRaw, ok := m["tokensUsed"]
	if !ok {
		return nil, false
	}
	tokensUsed, ok := asNumber(tuRaw)
	if !ok || tokensUsed < 0 {
		return nil, false
	}

	teRaw, ok := m["turnsExecuted"]
	if !ok {
		return nil, false
	}
	te, ok := asNumber(teRaw)
	if !ok || !isInteger(te) || te < 0 {
		return nil, false
	}

	amRaw, ok := m["activeMs"]
	if !ok {
		return nil, false
	}
	activeMs, ok := asNumber(amRaw)
	if !ok || activeMs < 0 {
		return nil, false
	}

	baRaw, ok := m["blockedAttempts"]
	if !ok {
		return nil, false
	}
	ba, ok := asNumber(baRaw)
	if !ok || !isInteger(ba) || ba < 0 {
		return nil, false
	}

	lbrRaw, ok := m["lastBlockReason"]
	if !ok {
		return nil, false
	}
	var lastBlockReason *string
	if lbrRaw != nil {
		s, ok := lbrRaw.(string)
		if !ok {
			return nil, false
		}
		lastBlockReason = &s
	}

	lbtRaw, ok := m["lastBlockedTurn"]
	if !ok {
		return nil, false
	}
	var lastBlockedTurn *int
	if lbtRaw != nil {
		f, ok := asNumber(lbtRaw)
		if !ok || !isInteger(f) {
			return nil, false
		}
		v := int(f)
		lastBlockedTurn = &v
	}

	bspRaw, ok := m["budgetSummaryPending"]
	if !ok {
		return nil, false
	}
	bsp, ok := bspRaw.(bool)
	if !ok {
		return nil, false
	}

	return &GoalState{
		Objective:            trimmed,
		Status:               status,
		TokenBudget:          tokenBudget,
		TokensUsed:           tokensUsed,
		TurnsExecuted:        int(te),
		ActiveMs:             activeMs,
		BlockedAttempts:      int(ba),
		LastBlockReason:      lastBlockReason,
		LastBlockedTurn:      lastBlockedTurn,
		BudgetSummaryPending: bsp,
	}, true
}

// GoalManager mirrors the reference GoalManager. It persists state as
// goal_state records in the session transcript and reconstructs the latest
// valid state on construction.
type GoalManager struct {
	mu            sync.Mutex
	cwd           string
	sessionID     string
	state         *GoalState
	activeSince   *int64
	trackingUsage bool
}

// log mirrors the reference goal module's child logger.
var log = logger.CreateChildLogger("goal")

// NewGoalManager restores goal state from the session transcript. The reference
// GoalManager constructor lets loadSession throw on a non-ENOENT read failure;
// Go logs and continues with no restored state instead of rippling an error
// return through every creation site (ui currentGoal, remote goal(), a2a
// runtime), whose many callers all expect a usable manager. The unrestored
// state matches the reference's practical effect; the read error is surfaced.
func NewGoalManager(cwd, sessionID string) *GoalManager {
	m := &GoalManager{cwd: cwd, sessionID: sessionID}
	records, err := session.LoadSession(cwd, sessionID)
	if err != nil {
		log.Error(map[string]any{"err": err, "cwd": cwd, "sessionId": sessionID}, "goal state restore failed")
		records = nil
	}
	for _, record := range records {
		if record.Type != GoalRecord {
			continue
		}
		var value any
		if err := json.Unmarshal([]byte(record.Content), &value); err != nil {
			continue
		}
		if value == nil {
			m.state = nil
			continue
		}
		obj, ok := value.(map[string]any)
		if !ok {
			continue
		}
		if parsed, ok := parseGoalState(obj); ok {
			m.state = parsed
		}
	}
	return m
}

func (m *GoalManager) SessionID() string { return m.sessionID }

// elapsed returns accumulated active milliseconds, including live time since the
// current activation.
func (m *GoalManager) elapsed() float64 {
	base := 0.0
	if m.state != nil {
		base = m.state.ActiveMs
	}
	live := 0.0
	if m.activeSince != nil {
		live = float64(time.Now().UnixMilli() - *m.activeSince)
		if live < 0 {
			live = 0
		}
	}
	return base + live
}

func (m *GoalManager) persist() {
	if m.state != nil {
		m.state.ActiveMs = m.elapsed()
	}
	if m.activeSince != nil {
		now := time.Now().UnixMilli()
		m.activeSince = &now
	}
	content, err := json.Marshal(m.state)
	if err != nil {
		content = []byte("null")
	}
	_ = session.SaveMessage(m.cwd, m.sessionID, session.Message{
		Role:      "system",
		Type:      GoalRecord,
		Content:   string(content),
		Timestamp: time.Now().Unix(),
	})
}

// Get returns a snapshot with the live active time folded in.
func (m *GoalManager) Get() *GoalState {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.snapshot()
}

func (m *GoalManager) snapshot() *GoalState {
	if m.state == nil {
		return nil
	}
	cp := *m.state
	cp.ActiveMs = m.elapsed()
	return &cp
}

func (m *GoalManager) Set(objective string, tokenBudget *float64, replace bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.set(objective, tokenBudget, replace)
}

func (m *GoalManager) set(objective string, tokenBudget *float64, replace bool) error {
	if m.state != nil && m.state.Status != "complete" && !replace {
		return errors.New(GoalAlreadyExistsError)
	}
	trimmed := strings.TrimSpace(objective)
	if utf16Length(trimmed) < 1 {
		return errors.New("Too small: expected string to have >=1 characters")
	}
	if utf16Length(trimmed) > MaxObjectiveChars {
		return errors.New("Too big: expected string to have <=4000 characters")
	}
	var budget *int64
	if tokenBudget != nil {
		f := *tokenBudget
		if !isInteger(f) || f <= 0 || f > maxSafeInteger {
			return errors.New("Too small: expected number to be >0")
		}
		v := int64(f)
		budget = &v
	}
	m.state = &GoalState{
		Objective:            trimmed,
		Status:               "active",
		TokenBudget:          budget,
		TokensUsed:           0,
		TurnsExecuted:        0,
		ActiveMs:             0,
		BlockedAttempts:      0,
		LastBlockReason:      nil,
		LastBlockedTurn:      nil,
		BudgetSummaryPending: false,
	}
	m.activeSince = nil
	m.trackingUsage = false
	m.persist()
	return nil
}

func (m *GoalManager) Clear() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.state = nil
	m.activeSince = nil
	m.trackingUsage = false
	m.persist()
}

func (m *GoalManager) Transition(status string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.transition(status)
}

func (m *GoalManager) transition(status string) error {
	if m.state == nil {
		return errors.New(NoGoalSetError)
	}
	m.state.ActiveMs = m.elapsed()
	m.activeSince = nil
	m.state.Status = status
	m.state.BudgetSummaryPending = status == "budget_limited"
	m.persist()
	return nil
}

func (m *GoalManager) Resume(resetTurns bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	g := m.state
	if g == nil || (g.Status != "paused" && g.Status != "blocked" && g.Status != "max_turns") {
		return errors.New(ResumeInvalidStateError)
	}
	if g.Status == "max_turns" && !resetTurns {
		return errors.New(ResumeTurnLimitedError)
	}
	if resetTurns && g.Status != "max_turns" {
		return errors.New(ContinueNotTurnLimitedError)
	}
	if g.TokenBudget != nil && g.TokensUsed >= float64(*g.TokenBudget) {
		return errors.New(BudgetExhaustedError)
	}
	if resetTurns {
		g.TurnsExecuted = 0
	}
	g.BlockedAttempts = 0
	g.LastBlockReason = nil
	g.LastBlockedTurn = nil
	return m.transition("active")
}

func (m *GoalManager) BeginTurn() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.state == nil || m.state.Status != "active" {
		return
	}
	m.trackingUsage = true
	if m.activeSince == nil {
		now := time.Now().UnixMilli()
		m.activeSince = &now
	}
	m.state.TurnsExecuted++
	m.persist()
}

func (m *GoalManager) EndRun() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.trackingUsage = false
	if m.activeSince == nil {
		return
	}
	if m.state != nil {
		m.state.ActiveMs = m.elapsed()
	}
	m.activeSince = nil
	m.persist()
}

func (m *GoalManager) AddTokens(tokens float64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.state == nil || !m.trackingUsage || math.IsNaN(tokens) || math.IsInf(tokens, 0) || tokens < 0 {
		return
	}
	m.state.TokensUsed += tokens
	if m.state.Status == "active" && m.state.TokenBudget != nil && m.state.TokensUsed >= float64(*m.state.TokenBudget) {
		_ = m.transition("budget_limited")
	} else {
		m.persist()
	}
}

// Update applies an agent-reported status change and returns the message to show.
func (m *GoalManager) Update(status, reason string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	g := m.state
	if g == nil || g.Status != "active" {
		return "", errors.New(UpdateInactiveGoalError)
	}
	if strings.TrimSpace(reason) == "" {
		return "", errors.New(ReasonRequiredError)
	}
	switch status {
	case "in_progress":
		g.BlockedAttempts = 0
		g.LastBlockReason = nil
		g.LastBlockedTurn = nil
		m.persist()
		return m.format(), nil
	case "complete":
		_ = m.transition("complete")
		return m.format(), nil
	}
	// blocked
	if g.LastBlockedTurn != nil && *g.LastBlockedTurn == g.TurnsExecuted {
		return DuplicateBlockerNotice, nil
	}
	same := g.LastBlockReason != nil &&
		strings.EqualFold(strings.TrimSpace(*g.LastBlockReason), strings.TrimSpace(reason)) &&
		g.LastBlockedTurn != nil && *g.LastBlockedTurn == g.TurnsExecuted-1
	if same {
		g.BlockedAttempts++
	} else {
		g.BlockedAttempts = 1
	}
	trimmedReason := strings.TrimSpace(reason)
	g.LastBlockReason = &trimmedReason
	turn := g.TurnsExecuted
	g.LastBlockedTurn = &turn
	if g.BlockedAttempts >= MaxBlockedAttempts {
		_ = m.transition("blocked")
	} else {
		m.persist()
	}
	return BuildBlockedAuditNotice(g.BlockedAttempts, m.format()), nil
}

// Continuation returns the next continuation prompt, or "" when the goal should
// not continue (inactive or turn-limited).
func (m *GoalManager) Continuation() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.state == nil || m.state.Status != "active" {
		return ""
	}
	if m.state.TurnsExecuted >= MaxGoalTurns {
		_ = m.transition("max_turns")
		return ""
	}
	return BuildContinuationPrompt(m.state.Objective)
}

// TakeBudgetSummary returns the one-shot budget-limit prompt, or "".
func (m *GoalManager) TakeBudgetSummary() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	g := m.state
	if g == nil || g.Status != "budget_limited" || !g.BudgetSummaryPending {
		return ""
	}
	g.BudgetSummaryPending = false
	m.trackingUsage = true
	m.persist()
	return BuildBudgetLimitPrompt(m.format())
}

// Reminder returns the persistent-goal reminder block, or "" when no goal is set.
func (m *GoalManager) Reminder() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.state == nil {
		return ""
	}
	return BuildGoalReminder(m.format())
}

func (m *GoalManager) Format() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.format()
}

func (m *GoalManager) format() string {
	return FormatGoalStatus(m.snapshot())
}

// CommandResult mirrors { message, prompt?, isError? }.
type CommandResult struct {
	Message string
	Prompt  string
	IsError bool
}

func errorResult(err error) CommandResult {
	return CommandResult{Message: "Error: " + err.Error(), IsError: true}
}

// HandleGoalCommand mirrors handleGoalCommand.
func HandleGoalCommand(m *GoalManager, args string) CommandResult {
	input := strings.TrimSpace(args)
	if input == "" || input == "status" {
		return CommandResult{Message: m.Format()}
	}
	if input == "clear" {
		m.Clear()
		return CommandResult{Message: GoalClearedMessage}
	}
	if input == "pause" || input == "complete" {
		if input == "pause" {
			if g := m.Get(); g == nil || g.Status != "active" {
				return errorResult(errors.New(PauseInactiveGoalError))
			}
		}
		target := "complete"
		if input == "pause" {
			target = "paused"
		}
		if err := m.Transition(target); err != nil {
			return errorResult(err)
		}
		return CommandResult{Message: m.Format()}
	}
	if input == "resume" || input == "continue" {
		if err := m.Resume(input == "continue"); err != nil {
			return errorResult(err)
		}
		return CommandResult{Message: m.Format(), Prompt: m.Continuation()}
	}
	replace := strings.HasPrefix(input, "replace ")
	if replace {
		input = strings.TrimSpace(input[len("replace "):])
	}
	var budget *float64
	if strings.HasPrefix(input, "--budget ") {
		match := BudgetArgPattern.FindStringSubmatch(input)
		if match == nil {
			return errorResult(errors.New(GoalUsage))
		}
		f, _ := strconv.ParseFloat(match[1], 64)
		budget = &f
		input = match[2]
	}
	if err := m.Set(input, budget, replace); err != nil {
		return errorResult(err)
	}
	return CommandResult{Message: m.Format(), Prompt: BuildGoalSetPrompt(input)}
}
