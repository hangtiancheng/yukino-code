package goal

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/yukino-js/yukino/yukino/internal/session"
)

func newTestManager(t *testing.T) *GoalManager {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	return NewGoalManager(t.TempDir(), "goal-test")
}

func int64Ptr(v int64) *int64       { return &v }
func float64Ptr(v float64) *float64 { return &v }
func strPtr(s string) *string       { return &s }
func intPtr(v int) *int             { return &v }

func TestFormatGoalStatusNil(t *testing.T) {
	if got := FormatGoalStatus(nil); got != NoGoalMessage {
		t.Fatalf("expected NoGoalMessage, got %q", got)
	}
}

func TestFormatGoalStatus(t *testing.T) {
	g := &GoalState{
		Objective:       "ship it",
		Status:          "active",
		TokenBudget:     int64Ptr(1000),
		TokensUsed:      250,
		TurnsExecuted:   3,
		ActiveMs:        61_500,
		LastBlockReason: strPtr("waiting on CI"),
	}
	got := FormatGoalStatus(g)
	want := "Goal: ship it\nStatus: active\nTokens: 250 / 1000\nActive time: 61s\nContinuation turns: 3 / 150\nBlocker: waiting on CI"
	if got != want {
		t.Fatalf("format mismatch:\ngot  %q\nwant %q", got, want)
	}
}

func TestFormatGoalStatusNoBudgetNoBlocker(t *testing.T) {
	g := &GoalState{Objective: "o", Status: "active", TokensUsed: 0, TurnsExecuted: 0, ActiveMs: 0}
	got := FormatGoalStatus(g)
	want := "Goal: o\nStatus: active\nTokens: 0\nActive time: 0s\nContinuation turns: 0 / 150"
	if got != want {
		t.Fatalf("format mismatch:\ngot  %q\nwant %q", got, want)
	}
}

func TestPromptBuilders(t *testing.T) {
	if got := BuildContinuationPrompt("obj"); got != "Continue working toward the persistent goal: obj\n"+ContinuationInstruction {
		t.Fatalf("continuation prompt mismatch: %q", got)
	}
	if got := BuildGoalReminder("report"); !strings.HasPrefix(got, PersistentGoalMarker+"\nreport\n") || !strings.HasSuffix(got, "\n</persistent-goal>") {
		t.Fatalf("reminder mismatch: %q", got)
	}
	if got := BuildBudgetLimitPrompt("r"); !strings.HasPrefix(got, "<goal-budget-limit>\nr\n") {
		t.Fatalf("budget prompt mismatch: %q", got)
	}
	if got := BuildBlockedAuditNotice(2, "r"); got != "Blocked audit: 2/3 consecutive turns.\nr" {
		t.Fatalf("audit notice mismatch: %q", got)
	}
	if got := BuildGoalSetPrompt("obj"); got != "Work toward this persistent goal: obj" {
		t.Fatalf("set prompt mismatch: %q", got)
	}
}

func TestSetAndGet(t *testing.T) {
	m := newTestManager(t)
	if m.Get() != nil {
		t.Fatalf("expected nil goal initially")
	}
	if err := m.Set("do the thing", nil, false); err != nil {
		t.Fatalf("set failed: %v", err)
	}
	g := m.Get()
	if g == nil || g.Objective != "do the thing" || g.Status != "active" {
		t.Fatalf("unexpected state: %+v", g)
	}
	if g.TokenBudget != nil || g.TokensUsed != 0 || g.TurnsExecuted != 0 {
		t.Fatalf("unexpected initial fields: %+v", g)
	}
}

func TestSetTrimsObjective(t *testing.T) {
	m := newTestManager(t)
	if err := m.Set("  padded  ", nil, false); err != nil {
		t.Fatalf("set failed: %v", err)
	}
	if got := m.Get().Objective; got != "padded" {
		t.Fatalf("expected trimmed objective, got %q", got)
	}
}

func TestSetAlreadyExists(t *testing.T) {
	m := newTestManager(t)
	_ = m.Set("first", nil, false)
	if err := m.Set("second", nil, false); err == nil || err.Error() != GoalAlreadyExistsError {
		t.Fatalf("expected GoalAlreadyExistsError, got %v", err)
	}
	if err := m.Set("second", nil, true); err != nil {
		t.Fatalf("replace failed: %v", err)
	}
	if got := m.Get().Objective; got != "second" {
		t.Fatalf("expected replaced objective, got %q", got)
	}
}

func TestSetAfterCompleteAllows(t *testing.T) {
	m := newTestManager(t)
	_ = m.Set("first", nil, false)
	_ = m.Transition("complete")
	if err := m.Set("second", nil, false); err != nil {
		t.Fatalf("set after complete should succeed: %v", err)
	}
}

func TestSetInvalidObjective(t *testing.T) {
	m := newTestManager(t)
	if err := m.Set("   ", nil, false); err == nil {
		t.Fatalf("expected error for blank objective")
	}
	if err := m.Set(strings.Repeat("x", MaxObjectiveChars+1), nil, false); err == nil {
		t.Fatalf("expected error for oversized objective")
	}
	if err := m.Set("ok", float64Ptr(0), false); err == nil {
		t.Fatalf("expected error for zero budget")
	}
	if err := m.Set("ok", float64Ptr(-5), false); err == nil {
		t.Fatalf("expected error for negative budget")
	}
}

func TestSetValidBudget(t *testing.T) {
	m := newTestManager(t)
	if err := m.Set("ok", float64Ptr(500), false); err != nil {
		t.Fatalf("set with budget failed: %v", err)
	}
	g := m.Get()
	if g.TokenBudget == nil || *g.TokenBudget != 500 {
		t.Fatalf("expected budget 500, got %+v", g.TokenBudget)
	}
}

func TestClear(t *testing.T) {
	m := newTestManager(t)
	_ = m.Set("x", nil, false)
	m.Clear()
	if m.Get() != nil {
		t.Fatalf("expected nil after clear")
	}
	if got := m.Format(); got != NoGoalMessage {
		t.Fatalf("expected NoGoalMessage after clear, got %q", got)
	}
}

func TestTransitionNoState(t *testing.T) {
	m := newTestManager(t)
	if err := m.Transition("paused"); err == nil || err.Error() != NoGoalSetError {
		t.Fatalf("expected NoGoalSetError, got %v", err)
	}
}

func TestTransitionSetsBudgetSummaryPending(t *testing.T) {
	m := newTestManager(t)
	_ = m.Set("x", float64Ptr(10), false)
	_ = m.Transition("budget_limited")
	if !m.Get().BudgetSummaryPending {
		t.Fatalf("expected budgetSummaryPending true")
	}
	_ = m.Transition("active")
	if m.Get().BudgetSummaryPending {
		t.Fatalf("expected budgetSummaryPending false after active")
	}
}

func TestResumeFromPaused(t *testing.T) {
	m := newTestManager(t)
	_ = m.Set("x", nil, false)
	_ = m.Transition("paused")
	if err := m.Resume(false); err != nil {
		t.Fatalf("resume failed: %v", err)
	}
	if m.Get().Status != "active" {
		t.Fatalf("expected active after resume")
	}
}

func TestResumeFromActiveInvalid(t *testing.T) {
	m := newTestManager(t)
	_ = m.Set("x", nil, false)
	if err := m.Resume(false); err == nil || err.Error() != ResumeInvalidStateError {
		t.Fatalf("expected ResumeInvalidStateError, got %v", err)
	}
}

func TestResumeTurnLimitedRequiresReset(t *testing.T) {
	m := newTestManager(t)
	_ = m.Set("x", nil, false)
	_ = m.Transition("max_turns")
	if err := m.Resume(false); err == nil || err.Error() != ResumeTurnLimitedError {
		t.Fatalf("expected ResumeTurnLimitedError, got %v", err)
	}
	if err := m.Resume(true); err != nil {
		t.Fatalf("resume with reset failed: %v", err)
	}
	if m.Get().TurnsExecuted != 0 || m.Get().Status != "active" {
		t.Fatalf("expected reset turns and active: %+v", m.Get())
	}
}

func TestContinueNonTurnLimitedInvalid(t *testing.T) {
	m := newTestManager(t)
	_ = m.Set("x", nil, false)
	_ = m.Transition("paused")
	if err := m.Resume(true); err == nil || err.Error() != ContinueNotTurnLimitedError {
		t.Fatalf("expected ContinueNotTurnLimitedError, got %v", err)
	}
}

func TestResumeExhaustedBudget(t *testing.T) {
	m := newTestManager(t)
	_ = m.Set("x", float64Ptr(10), false)
	m.BeginTurn()
	m.AddTokens(10) // -> budget_limited
	_ = m.Transition("paused")
	if err := m.Resume(false); err == nil || err.Error() != BudgetExhaustedError {
		t.Fatalf("expected BudgetExhaustedError, got %v", err)
	}
}

func TestBeginTurnAndAddTokens(t *testing.T) {
	m := newTestManager(t)
	_ = m.Set("x", float64Ptr(100), false)
	m.BeginTurn()
	if m.Get().TurnsExecuted != 1 {
		t.Fatalf("expected 1 turn, got %d", m.Get().TurnsExecuted)
	}
	m.AddTokens(40)
	if m.Get().TokensUsed != 40 || m.Get().Status != "active" {
		t.Fatalf("unexpected after addTokens: %+v", m.Get())
	}
	m.AddTokens(60) // reaches budget
	g := m.Get()
	if g.Status != "budget_limited" || !g.BudgetSummaryPending {
		t.Fatalf("expected budget_limited, got %+v", g)
	}
}

func TestAddTokensIgnoredWhenNotTracking(t *testing.T) {
	m := newTestManager(t)
	_ = m.Set("x", nil, false)
	m.AddTokens(100) // no BeginTurn, trackingUsage false
	if m.Get().TokensUsed != 0 {
		t.Fatalf("expected tokens ignored before BeginTurn, got %v", m.Get().TokensUsed)
	}
}

func TestAddTokensIgnoresInvalid(t *testing.T) {
	m := newTestManager(t)
	_ = m.Set("x", nil, false)
	m.BeginTurn()
	m.AddTokens(-5)
	if m.Get().TokensUsed != 0 {
		t.Fatalf("expected negative tokens ignored")
	}
}

func TestUpdateInProgressResetsBlocked(t *testing.T) {
	m := newTestManager(t)
	_ = m.Set("x", nil, false)
	m.BeginTurn()
	_, _ = m.Update("blocked", "reason")
	out, err := m.Update("in_progress", "making progress")
	if err != nil {
		t.Fatalf("update failed: %v", err)
	}
	g := m.Get()
	if g.BlockedAttempts != 0 || g.LastBlockReason != nil || g.LastBlockedTurn != nil {
		t.Fatalf("expected blocked state reset: %+v", g)
	}
	if !strings.HasPrefix(out, "Goal: x") {
		t.Fatalf("expected formatted status, got %q", out)
	}
}

func TestUpdateComplete(t *testing.T) {
	m := newTestManager(t)
	_ = m.Set("x", nil, false)
	m.BeginTurn()
	if _, err := m.Update("complete", "done"); err != nil {
		t.Fatalf("update complete failed: %v", err)
	}
	if m.Get().Status != "complete" {
		t.Fatalf("expected complete")
	}
}

func TestUpdateInactive(t *testing.T) {
	m := newTestManager(t)
	if _, err := m.Update("in_progress", "x"); err == nil || err.Error() != UpdateInactiveGoalError {
		t.Fatalf("expected UpdateInactiveGoalError, got %v", err)
	}
}

func TestUpdateEmptyReason(t *testing.T) {
	m := newTestManager(t)
	_ = m.Set("x", nil, false)
	m.BeginTurn()
	if _, err := m.Update("blocked", "   "); err == nil || err.Error() != ReasonRequiredError {
		t.Fatalf("expected ReasonRequiredError, got %v", err)
	}
}

func TestBlockedAuditConsecutive(t *testing.T) {
	m := newTestManager(t)
	_ = m.Set("x", nil, false)

	m.BeginTurn() // turn 1
	out, _ := m.Update("blocked", "same blocker")
	if !strings.HasPrefix(out, "Blocked audit: 1/3") {
		t.Fatalf("expected 1/3, got %q", out)
	}

	m.BeginTurn() // turn 2
	out, _ = m.Update("blocked", "same blocker")
	if !strings.HasPrefix(out, "Blocked audit: 2/3") {
		t.Fatalf("expected 2/3, got %q", out)
	}

	m.BeginTurn() // turn 3
	out, _ = m.Update("blocked", "same blocker")
	if !strings.HasPrefix(out, "Blocked audit: 3/3") {
		t.Fatalf("expected 3/3, got %q", out)
	}
	if m.Get().Status != "blocked" {
		t.Fatalf("expected blocked after 3 attempts, got %s", m.Get().Status)
	}
}

func TestBlockedAuditDifferentResets(t *testing.T) {
	m := newTestManager(t)
	_ = m.Set("x", nil, false)
	m.BeginTurn()
	_, _ = m.Update("blocked", "blocker A")
	m.BeginTurn()
	out, _ := m.Update("blocked", "blocker B")
	if !strings.HasPrefix(out, "Blocked audit: 1/3") {
		t.Fatalf("expected reset to 1/3 for different blocker, got %q", out)
	}
}

func TestBlockedAuditDuplicateSameTurn(t *testing.T) {
	m := newTestManager(t)
	_ = m.Set("x", nil, false)
	m.BeginTurn()
	_, _ = m.Update("blocked", "blocker")
	out, err := m.Update("blocked", "blocker")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out != DuplicateBlockerNotice {
		t.Fatalf("expected duplicate notice, got %q", out)
	}
	if m.Get().BlockedAttempts != 1 {
		t.Fatalf("expected attempts to stay 1, got %d", m.Get().BlockedAttempts)
	}
}

func TestContinuation(t *testing.T) {
	m := newTestManager(t)
	_ = m.Set("obj", nil, false)
	m.BeginTurn()
	got := m.Continuation()
	if !strings.HasPrefix(got, "Continue working toward the persistent goal: obj") {
		t.Fatalf("unexpected continuation: %q", got)
	}
}

func TestContinuationInactive(t *testing.T) {
	m := newTestManager(t)
	if got := m.Continuation(); got != "" {
		t.Fatalf("expected empty continuation with no goal, got %q", got)
	}
}

func TestContinuationMaxTurns(t *testing.T) {
	m := newTestManager(t)
	_ = m.Set("obj", nil, false)
	// Force turnsExecuted to the limit via a persisted record.
	m.state.TurnsExecuted = MaxGoalTurns
	if got := m.Continuation(); got != "" {
		t.Fatalf("expected empty continuation at max turns, got %q", got)
	}
	if m.Get().Status != "max_turns" {
		t.Fatalf("expected max_turns, got %s", m.Get().Status)
	}
}

func TestTakeBudgetSummary(t *testing.T) {
	m := newTestManager(t)
	_ = m.Set("x", float64Ptr(10), false)
	m.BeginTurn()
	m.AddTokens(10) // -> budget_limited, pending
	out := m.TakeBudgetSummary()
	if !strings.HasPrefix(out, "<goal-budget-limit>") {
		t.Fatalf("expected budget limit prompt, got %q", out)
	}
	if again := m.TakeBudgetSummary(); again != "" {
		t.Fatalf("expected one-shot summary, got %q", again)
	}
}

func TestReminder(t *testing.T) {
	m := newTestManager(t)
	if got := m.Reminder(); got != "" {
		t.Fatalf("expected empty reminder with no goal, got %q", got)
	}
	_ = m.Set("x", nil, false)
	got := m.Reminder()
	if !strings.HasPrefix(got, PersistentGoalMarker+"\n") || !strings.Contains(got, "Goal: x") {
		t.Fatalf("unexpected reminder: %q", got)
	}
}

func TestPersistenceRoundTrip(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	cwd := t.TempDir()
	sid := "goal-rt"

	m := NewGoalManager(cwd, sid)
	_ = m.Set("persist me", float64Ptr(42), false)
	m.BeginTurn()
	m.AddTokens(7)

	m2 := NewGoalManager(cwd, sid)
	g := m2.Get()
	if g == nil || g.Objective != "persist me" {
		t.Fatalf("expected reloaded objective, got %+v", g)
	}
	if g.TokenBudget == nil || *g.TokenBudget != 42 {
		t.Fatalf("expected budget 42, got %+v", g.TokenBudget)
	}
	if g.TurnsExecuted != 1 || g.TokensUsed != 7 {
		t.Fatalf("expected turns=1 tokens=7, got %+v", g)
	}
}

func TestPersistenceClearRecord(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	cwd := t.TempDir()
	sid := "goal-clear"

	m := NewGoalManager(cwd, sid)
	_ = m.Set("x", nil, false)
	m.Clear()

	m2 := NewGoalManager(cwd, sid)
	if m2.Get() != nil {
		t.Fatalf("expected nil goal after clear round-trip")
	}
}

func TestLoadSkipsMalformedRecords(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	cwd := t.TempDir()
	sid := "goal-malformed"

	// Write a valid goal then a malformed one; the valid one must survive.
	m := NewGoalManager(cwd, sid)
	_ = m.Set("valid", nil, false)
	_ = session.SaveMessage(cwd, sid, session.Message{Role: "system", Type: GoalRecord, Content: "{not json", Timestamp: 1})

	m2 := NewGoalManager(cwd, sid)
	if g := m2.Get(); g == nil || g.Objective != "valid" {
		t.Fatalf("expected last valid goal to survive malformed record, got %+v", g)
	}
}

func TestParseGoalStateRejectsMissingKeys(t *testing.T) {
	valid := map[string]any{
		"objective": "o", "status": "active", "tokenBudget": nil,
		"tokensUsed": float64(0), "turnsExecuted": float64(0), "activeMs": float64(0),
		"blockedAttempts": float64(0), "lastBlockReason": nil, "lastBlockedTurn": nil,
		"budgetSummaryPending": false,
	}
	if _, ok := parseGoalState(valid); !ok {
		t.Fatalf("expected valid record to parse")
	}
	for key := range valid {
		clone := map[string]any{}
		for k, v := range valid {
			clone[k] = v
		}
		delete(clone, key)
		if _, ok := parseGoalState(clone); ok {
			t.Fatalf("expected record missing %q to be rejected", key)
		}
	}
}

func TestParseGoalStateRejectsBadValues(t *testing.T) {
	base := func() map[string]any {
		return map[string]any{
			"objective": "o", "status": "active", "tokenBudget": nil,
			"tokensUsed": float64(0), "turnsExecuted": float64(0), "activeMs": float64(0),
			"blockedAttempts": float64(0), "lastBlockReason": nil, "lastBlockedTurn": nil,
			"budgetSummaryPending": false,
		}
	}
	cases := map[string]func(map[string]any){
		"bad status":       func(m map[string]any) { m["status"] = "running" },
		"negative tokens":  func(m map[string]any) { m["tokensUsed"] = float64(-1) },
		"non-int turns":    func(m map[string]any) { m["turnsExecuted"] = 1.5 },
		"zero budget":      func(m map[string]any) { m["tokenBudget"] = float64(0) },
		"bool objective":   func(m map[string]any) { m["objective"] = true },
		"non-bool pending": func(m map[string]any) { m["budgetSummaryPending"] = "yes" },
	}
	for name, mutate := range cases {
		m := base()
		mutate(m)
		if _, ok := parseGoalState(m); ok {
			t.Fatalf("expected %s to be rejected", name)
		}
	}
}

func TestHandleGoalCommandStatus(t *testing.T) {
	m := newTestManager(t)
	res := HandleGoalCommand(m, "")
	if res.IsError || res.Message != NoGoalMessage {
		t.Fatalf("expected status message, got %+v", res)
	}
	res = HandleGoalCommand(m, "status")
	if res.IsError || res.Message != NoGoalMessage {
		t.Fatalf("expected status message, got %+v", res)
	}
}

func TestHandleGoalCommandSet(t *testing.T) {
	m := newTestManager(t)
	res := HandleGoalCommand(m, "make it so")
	if res.IsError {
		t.Fatalf("unexpected error: %+v", res)
	}
	if res.Prompt != BuildGoalSetPrompt("make it so") {
		t.Fatalf("expected set prompt, got %q", res.Prompt)
	}
	if m.Get().Objective != "make it so" {
		t.Fatalf("expected objective set")
	}
}

func TestHandleGoalCommandReplaceAndBudget(t *testing.T) {
	m := newTestManager(t)
	_ = HandleGoalCommand(m, "first")
	res := HandleGoalCommand(m, "replace --budget 500 second")
	if res.IsError {
		t.Fatalf("unexpected error: %+v", res)
	}
	g := m.Get()
	if g.Objective != "second" || g.TokenBudget == nil || *g.TokenBudget != 500 {
		t.Fatalf("expected replaced goal with budget, got %+v", g)
	}
}

func TestHandleGoalCommandBudgetOnlyNoObjective(t *testing.T) {
	m := newTestManager(t)
	res := HandleGoalCommand(m, "--budget 100")
	if !res.IsError || res.Message != "Error: "+GoalUsage {
		t.Fatalf("expected usage error, got %+v", res)
	}
}

func TestHandleGoalCommandPauseComplete(t *testing.T) {
	m := newTestManager(t)
	_ = HandleGoalCommand(m, "x")
	res := HandleGoalCommand(m, "pause")
	if res.IsError || m.Get().Status != "paused" {
		t.Fatalf("expected paused, got %+v / %+v", res, m.Get())
	}
	res = HandleGoalCommand(m, "resume")
	if res.IsError || m.Get().Status != "active" {
		t.Fatalf("expected resumed, got %+v", res)
	}
	res = HandleGoalCommand(m, "complete")
	if res.IsError || m.Get().Status != "complete" {
		t.Fatalf("expected complete, got %+v", res)
	}
}

func TestHandleGoalCommandPauseInactive(t *testing.T) {
	m := newTestManager(t)
	res := HandleGoalCommand(m, "pause")
	if !res.IsError || res.Message != "Error: "+PauseInactiveGoalError {
		t.Fatalf("expected pause inactive error, got %+v", res)
	}
}

func TestHandleGoalCommandResumeReturnsContinuation(t *testing.T) {
	m := newTestManager(t)
	_ = HandleGoalCommand(m, "obj")
	_ = HandleGoalCommand(m, "pause")
	res := HandleGoalCommand(m, "resume")
	if res.IsError {
		t.Fatalf("unexpected error: %+v", res)
	}
	if !strings.HasPrefix(res.Prompt, "Continue working toward the persistent goal: obj") {
		t.Fatalf("expected continuation prompt, got %q", res.Prompt)
	}
}

func TestHandleGoalCommandClear(t *testing.T) {
	m := newTestManager(t)
	_ = HandleGoalCommand(m, "x")
	res := HandleGoalCommand(m, "clear")
	if res.IsError || res.Message != GoalClearedMessage {
		t.Fatalf("expected cleared, got %+v", res)
	}
	if m.Get() != nil {
		t.Fatalf("expected nil goal")
	}
}

func TestGoalStateJSONShape(t *testing.T) {
	g := &GoalState{Objective: "o", Status: "active", TokenBudget: int64Ptr(5), TokensUsed: 1, TurnsExecuted: 2, ActiveMs: 3, BlockedAttempts: 0, LastBlockReason: nil, LastBlockedTurn: intPtr(4), BudgetSummaryPending: true}
	data, err := json.Marshal(g)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}
	var round map[string]any
	_ = json.Unmarshal(data, &round)
	for _, key := range []string{"objective", "status", "tokenBudget", "tokensUsed", "turnsExecuted", "activeMs", "blockedAttempts", "lastBlockReason", "lastBlockedTurn", "budgetSummaryPending"} {
		if _, ok := round[key]; !ok {
			t.Fatalf("missing JSON key %q in %s", key, data)
		}
	}
}
