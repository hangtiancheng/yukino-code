package remote

import (
	"context"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/yukino-js/yukino/yukino/internal/agent"
	"github.com/yukino-js/yukino/yukino/internal/commands"
	"github.com/yukino-js/yukino/yukino/internal/config"
	"github.com/yukino-js/yukino/yukino/internal/conversation"
	"github.com/yukino-js/yukino/yukino/internal/file_history"
	"github.com/yukino-js/yukino/yukino/internal/history"
	"github.com/yukino-js/yukino/yukino/internal/permissions"
	"github.com/yukino-js/yukino/yukino/internal/subagent"
	"github.com/yukino-js/yukino/yukino/internal/teams"
	"github.com/yukino-js/yukino/yukino/internal/tools"

	"github.com/gorilla/websocket"
)

func newBootstrapServer(t *testing.T) *Server {
	t.Helper()
	wd := t.TempDir()
	s := NewServer([]config.ProviderConfig{{Name: "prov", Protocol: "openai", Model: "model-x", Thinking: "low"}}, nil, nil, "", false, 0, nil, true)
	s.conv = conversation.NewManager()
	s.ag = &agent.Agent{
		Checker:       permissions.NewChecker(permissions.NewPathSandbox(wd, true), permissions.NewRuleEngine(wd), permissions.ModeDefault),
		ContextWindow: 200000,
	}
	s.ag.Checker.SandboxEnabled = true
	s.ag.Checker.SandboxAutoAllow = true
	return s
}

func TestStatusPayloadFallsBackToProviderThinking(t *testing.T) {
	s := newBootstrapServer(t)
	// client is nil, so the ThinkingLevelControl assertion fails and the
	// payload must fall back to provider.Thinking / GetSupportedThinkingLevels.
	msg, ok := s.statusPayload()
	if !ok {
		t.Fatal("statusPayload reported unavailable with a ready agent")
	}
	data, isMap := msg.Data.(map[string]any)
	if !isMap {
		t.Fatalf("status data = %#v", msg.Data)
	}
	if msg.Type != "status" {
		t.Fatalf("type = %q", msg.Type)
	}
	if data["model"] != "model-x" || data["provider"] != "prov" {
		t.Fatalf("model/provider = %v / %v", data["model"], data["provider"])
	}
	if data["permissionMode"] != string(permissions.ModeDefault) {
		t.Fatalf("permissionMode = %v", data["permissionMode"])
	}
	if data["thinkingLevel"] != "low" {
		t.Fatalf("thinkingLevel = %v, want provider fallback 'low'", data["thinkingLevel"])
	}
	levels, isSlice := data["thinkingLevels"].([]string)
	if !isSlice || len(levels) == 0 {
		t.Fatalf("thinkingLevels = %#v", data["thinkingLevels"])
	}
	if data["sandboxEnabled"] != true || data["sandboxAutoAllow"] != true {
		t.Fatalf("sandbox flags = %v / %v", data["sandboxEnabled"], data["sandboxAutoAllow"])
	}
	if data["contextWindow"] != 200000 {
		t.Fatalf("contextWindow = %v", data["contextWindow"])
	}
}

func TestStatusPayloadUnavailableWithoutAgent(t *testing.T) {
	s := NewServer(nil, nil, nil, "", false, 0, nil, true)
	if _, ok := s.statusPayload(); ok {
		t.Fatal("statusPayload must be unavailable before the agent exists")
	}
}

func TestUsagePayloadSnapshot(t *testing.T) {
	s := newBootstrapServer(t)
	s.lastUsageInput = 11
	s.lastUsageOutput = 22
	s.conv.AddUserMessage("hello world")
	data := s.usagePayload()
	if data["inputTokens"] != 11 || data["outputTokens"] != 22 {
		t.Fatalf("token counts = %v / %v", data["inputTokens"], data["outputTokens"])
	}
	if data["contextWindow"] != 200000 {
		t.Fatalf("contextWindow = %v", data["contextWindow"])
	}
	if ctx, ok := data["contextTokens"].(int); !ok || ctx <= 0 {
		t.Fatalf("contextTokens = %#v, want a positive estimate", data["contextTokens"])
	}
}

func TestBroadcastProviderList(t *testing.T) {
	s := NewServer([]config.ProviderConfig{
		{Name: "a", Protocol: "openai", BaseURL: "http://a", Model: "ma"},
		{Name: "b", Protocol: "anthropic", BaseURL: "http://b", Model: "mb"},
	}, nil, nil, "", false, 1, nil, true)
	client := dialClient(t, s)

	s.broadcastProviderList()

	_ = client.SetReadDeadline(time.Now().Add(2 * time.Second))
	var msg struct {
		Type string `json:"type"`
		Data struct {
			Providers []map[string]string `json:"providers"`
			Current   int                 `json:"current"`
		} `json:"data"`
	}
	if err := client.ReadJSON(&msg); err != nil {
		t.Fatal(err)
	}
	if msg.Type != "provider_list" {
		t.Fatalf("type = %q", msg.Type)
	}
	if len(msg.Data.Providers) != 2 || msg.Data.Providers[0]["name"] != "a" || msg.Data.Providers[1]["base_url"] != "http://b" {
		t.Fatalf("providers = %#v", msg.Data.Providers)
	}
	if msg.Data.Current != 1 {
		t.Fatalf("current = %d, want 1 (active provider 'b')", msg.Data.Current)
	}
}

func TestApplyPermissionModeTransitions(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	s := newBootstrapServer(t)
	checker := s.ag.Checker

	exited := func() bool {
		s.planMu.Lock()
		defer s.planMu.Unlock()
		return s.hasExitedPlanMode
	}

	// default -> plan enters plan mode and creates a plan file.
	s.applyPermissionMode(permissions.ModePlan)
	if checker.Mode() != permissions.ModePlan {
		t.Fatalf("mode = %v, want plan", checker.Mode())
	}
	if checker.CurrentPlanPath() == "" {
		t.Fatal("plan path was not created on entry")
	}
	if exited() {
		t.Fatal("hasExitedPlanMode must be false after entering plan mode")
	}

	// plan -> plan is a no-op.
	s.applyPermissionMode(permissions.ModePlan)
	if checker.Mode() != permissions.ModePlan {
		t.Fatalf("no-op transition changed mode: %v", checker.Mode())
	}

	// plan -> default exits and flags hasExitedPlanMode.
	s.applyPermissionMode(permissions.ModeDefault)
	if checker.Mode() != permissions.ModeDefault {
		t.Fatalf("mode = %v, want default", checker.Mode())
	}
	if !exited() {
		t.Fatal("hasExitedPlanMode must be true after exiting plan mode")
	}

	// Re-entering plan resets the flag and exercises the reentry reminder.
	s.applyPermissionMode(permissions.ModePlan)
	if checker.Mode() != permissions.ModePlan {
		t.Fatalf("mode = %v, want plan on re-entry", checker.Mode())
	}
	if exited() {
		t.Fatal("hasExitedPlanMode must reset to false on re-entry")
	}

	// plan -> bypass exits into YOLO.
	s.applyPermissionMode(permissions.ModeBypass)
	if checker.Mode() != permissions.ModeBypass {
		t.Fatalf("mode = %v, want bypassPermissions", checker.Mode())
	}
}

func TestSendFileCompletions(t *testing.T) {
	s := newBootstrapServer(t)
	dir := t.TempDir()
	for _, name := range []string{"alpha.txt", "alphabet.md", "beta.txt"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	s.ag.WorkDir = dir
	serverConn, client := dialPair(t, s)

	s.sendFileCompletions(serverConn, "req-1", "alpha")

	_ = client.SetReadDeadline(time.Now().Add(2 * time.Second))
	var msg struct {
		Type string `json:"type"`
		Data struct {
			RequestID string   `json:"requestId"`
			Matches   []string `json:"matches"`
		} `json:"data"`
	}
	if err := client.ReadJSON(&msg); err != nil {
		t.Fatal(err)
	}
	if msg.Type != "file_complete_response" || msg.Data.RequestID != "req-1" {
		t.Fatalf("msg = %#v", msg)
	}
	if len(msg.Data.Matches) < 2 || msg.Data.Matches[0] != "alpha.txt" || msg.Data.Matches[1] != "alphabet.md" {
		t.Fatalf("matches = %#v, want prefix matches first", msg.Data.Matches)
	}
}

func TestBackgroundForegroundShellsNoOpWithoutRegistry(t *testing.T) {
	s := NewServer(nil, nil, nil, "", false, 0, nil, true)
	// nil registry: the guard must short-circuit without panicking.
	s.backgroundForegroundShells()
}

func TestHandleImageUpload(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	s := newBootstrapServer(t)
	s.sessionID = "sess-upload"
	serverConn, client := dialPair(t, s)

	png := []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01}
	s.handleImageUpload(serverConn, imageUploadData{
		ClientID:   "c1",
		Name:       "my picture.png",
		DataBase64: base64.StdEncoding.EncodeToString(png),
	})

	_ = client.SetReadDeadline(time.Now().Add(2 * time.Second))
	var saved struct {
		Type string `json:"type"`
		Data struct {
			ClientID string `json:"clientId"`
			Path     string `json:"path"`
		} `json:"data"`
	}
	if err := client.ReadJSON(&saved); err != nil {
		t.Fatal(err)
	}
	if saved.Type != "image_saved" || saved.Data.ClientID != "c1" {
		t.Fatalf("saved = %#v", saved)
	}
	if !strings.HasSuffix(saved.Data.Path, ".png") || !strings.Contains(saved.Data.Path, "upload-") || !strings.Contains(saved.Data.Path, "my_picture") {
		t.Fatalf("path = %q, want sanitized upload-...-my_picture.png", saved.Data.Path)
	}
	if _, err := os.Stat(saved.Data.Path); err != nil {
		t.Fatalf("saved file missing: %v", err)
	}

	// Unrecognized bytes are rejected.
	s.handleImageUpload(serverConn, imageUploadData{
		ClientID:   "c2",
		Name:       "bad.png",
		DataBase64: base64.StdEncoding.EncodeToString([]byte("not an image")),
	})
	_ = client.SetReadDeadline(time.Now().Add(2 * time.Second))
	var failed struct {
		Type string `json:"type"`
		Data struct {
			ClientID string `json:"clientId"`
			Message  string `json:"message"`
		} `json:"data"`
	}
	if err := client.ReadJSON(&failed); err != nil {
		t.Fatal(err)
	}
	if failed.Type != "image_error" || failed.Data.ClientID != "c2" || failed.Data.Message == "" {
		t.Fatalf("failed = %#v", failed)
	}
}

func newRewindServer(t *testing.T) (*Server, *websocket.Conn) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	s := newBootstrapServer(t)
	s.sessionID = "sess-rewind"
	s.fileHistory = file_history.New("sess-rewind")
	client := dialClient(t, s)
	return s, client
}

func readJSON(t *testing.T, client *websocket.Conn) map[string]any {
	t.Helper()
	_ = client.SetReadDeadline(time.Now().Add(2 * time.Second))
	var msg map[string]any
	if err := client.ReadJSON(&msg); err != nil {
		t.Fatal(err)
	}
	return msg
}

func TestBroadcastRewindListNoSnapshots(t *testing.T) {
	s, client := newRewindServer(t)
	s.broadcastRewindList()
	msg := readJSON(t, client)
	if msg["type"] != "system" {
		t.Fatalf("type = %v", msg["type"])
	}
	data := msg["data"].(map[string]any)
	if data["message"] != "No checkpoints to rewind to." {
		t.Fatalf("message = %v", data["message"])
	}
}

func TestBroadcastRewindListWithSnapshots(t *testing.T) {
	s, client := newRewindServer(t)
	s.fileHistory.MakeSnapshot(3, "do the thing", nil)
	s.broadcastRewindList()
	msg := readJSON(t, client)
	if msg["type"] != "rewind_list" {
		t.Fatalf("type = %v", msg["type"])
	}
	data := msg["data"].(map[string]any)
	snapshots := data["snapshots"].([]any)
	if len(snapshots) != 1 {
		t.Fatalf("snapshots = %#v", snapshots)
	}
	snap := snapshots[0].(map[string]any)
	if snap["userText"] != "do the thing" || snap["index"] != float64(0) || snap["id"] == "" || snap["id"] == nil {
		t.Fatalf("snap = %#v", snap)
	}
}

func TestHandleRewindActionUnknownSnapshot(t *testing.T) {
	s, client := newRewindServer(t)
	s.fileHistory.MakeSnapshot(1, "snap", nil)
	s.handleRewindAction("nonexistent-id", "code_only")
	msg := readJSON(t, client)
	if msg["type"] != "error" {
		t.Fatalf("type = %v", msg["type"])
	}
	data := msg["data"].(map[string]any)
	if !strings.Contains(data["message"].(string), "checkpoint is no longer available") {
		t.Fatalf("message = %v", data["message"])
	}
}

func TestHandleRewindActionWhileStreaming(t *testing.T) {
	s, client := newRewindServer(t)
	s.fileHistory.MakeSnapshot(1, "snap", nil)
	s.runMu.Lock()
	s.streaming = true
	s.runMu.Unlock()
	s.handleRewindAction("any-id", "code_only")
	msg := readJSON(t, client)
	if msg["type"] != "system" {
		t.Fatalf("type = %v", msg["type"])
	}
	data := msg["data"].(map[string]any)
	if data["message"] != "Cannot rewind while a run is in progress." {
		t.Fatalf("message = %v", data["message"])
	}
}

func TestHandleRewindActionConversationOnly(t *testing.T) {
	s, client := newRewindServer(t)
	s.conv.AddUserMessage("first user")
	s.conv.AddAssistantFull("first assistant", nil, nil)
	s.conv.AddUserMessage("second user")
	s.fileHistory.MakeSnapshot(1, "checkpoint", nil)
	snapshotID := s.fileHistory.GetSnapshots()[0].ID

	s.handleRewindAction(snapshotID, "conversation_only")

	clearMsg := readJSON(t, client)
	if clearMsg["type"] != "clear" {
		t.Fatalf("expected clear, got %v", clearMsg["type"])
	}
	replay := readJSON(t, client)
	if replay["type"] != "replay_user" || replay["data"].(map[string]any)["content"] != "first user" {
		t.Fatalf("replay = %#v", replay)
	}
	systemMsg := readJSON(t, client)
	if systemMsg["type"] != "system" || systemMsg["data"].(map[string]any)["message"] != "⟲ Rewound conversation. Files unchanged." {
		t.Fatalf("system = %#v", systemMsg)
	}
	if got := s.conv.Len(); got != 1 {
		t.Fatalf("conv len = %d, want 1 after truncate", got)
	}
}

func newProviderServer(t *testing.T) (*Server, *websocket.Conn) {
	t.Helper()
	s := NewServer([]config.ProviderConfig{
		{Name: "a", Protocol: "openai", BaseURL: "http://a", Model: "ma"},
		{Name: "b", Protocol: "anthropic", BaseURL: "http://b", Model: "mb"},
	}, nil, nil, "", false, 0, nil, true)
	s.ag = &agent.Agent{}
	client := dialClient(t, s)
	return s, client
}

func TestChangeProviderConfigurationBlockedWhileStreaming(t *testing.T) {
	s, client := newProviderServer(t)
	s.runMu.Lock()
	s.streaming = true
	s.runMu.Unlock()
	called := false
	s.changeProviderConfiguration(func() { called = true })
	if called {
		t.Fatal("change must not run while a run is in progress")
	}
	msg := readJSON(t, client)
	if msg["type"] != "system" || !strings.Contains(msg["data"].(map[string]any)["message"].(string), "Cannot change models or providers") {
		t.Fatalf("msg = %#v", msg)
	}
}

func TestApplyModelAlreadySet(t *testing.T) {
	s, client := newProviderServer(t)
	s.applyModel("ma")
	msg := readJSON(t, client)
	if msg["type"] != "system" || msg["data"].(map[string]any)["message"] != "Model already set to ma." {
		t.Fatalf("msg = %#v", msg)
	}
}

func TestApplyProviderSwitchUnknownIndex(t *testing.T) {
	s, client := newProviderServer(t)
	s.applyProviderSwitch(5)
	msg := readJSON(t, client)
	if msg["type"] != "error" || !strings.Contains(msg["data"].(map[string]any)["message"].(string), "Unknown provider index: 5") {
		t.Fatalf("msg = %#v", msg)
	}
}

func TestSteerRequiresActiveRun(t *testing.T) {
	s := NewServer(nil, nil, nil, "", false, 0, nil, true)
	s.ag = &agent.Agent{}
	if s.steer("hello", nil) {
		t.Fatal("steer must fail when no run is active")
	}
}

func TestHandleSteeringMessageEnqueuesFollowUpWhenIdle(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	s := NewServer(nil, nil, nil, "", false, 0, nil, true)
	s.ag = &agent.Agent{}
	s.sessionID = "sess-steer"
	client := dialClient(t, s)

	s.handleSteeringMessage("do this later", nil)

	msg := readJSON(t, client)
	if msg["type"] != "followups" {
		t.Fatalf("type = %v", msg["type"])
	}
	list := msg["data"].(map[string]any)["list"].([]any)
	if len(list) != 1 || list[0] != "do this later" {
		t.Fatalf("list = %#v", list)
	}
	s.followUpsMu.Lock()
	queued := len(s.followUps)
	s.followUpsMu.Unlock()
	if queued != 1 {
		t.Fatalf("followUps = %d, want 1", queued)
	}
}

func TestHandleSteeringMessageSlashCommandFollowUp(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	s := NewServer(nil, nil, nil, "", false, 0, nil, true)
	s.ag = &agent.Agent{}
	s.sessionID = "sess-steer"
	s.cmdRegistry = commands.CreateDefaultRegistry()
	client := dialClient(t, s)

	// A known slash command mid-run becomes a follow-up, not steering.
	s.handleSteeringMessage("/help", nil)

	msg := readJSON(t, client)
	if msg["type"] != "followups" {
		t.Fatalf("type = %v", msg["type"])
	}
	list := msg["data"].(map[string]any)["list"].([]any)
	if len(list) != 1 || list[0] != "/help" {
		t.Fatalf("list = %#v", list)
	}
}

func TestSubagentProgressStateMachine(t *testing.T) {
	s := NewServer(nil, nil, nil, "", false, 0, nil, true)
	client := dialClient(t, s)

	subagents := func() []any {
		msg := readJSON(t, client)
		if msg["type"] != "subagents" {
			t.Fatalf("type = %v", msg["type"])
		}
		return msg["data"].(map[string]any)["list"].([]any)
	}

	// started
	s.handleSubagentProgress(subagent.SubAgentProgress{ToolCallID: "tc-1", Role: "researcher", Status: "running"})
	list := subagents()
	if len(list) != 1 {
		t.Fatalf("list = %#v", list)
	}
	entry := list[0].(map[string]any)
	if entry["toolCallId"] != "tc-1" || entry["role"] != "researcher" || entry["status"] != "running" || entry["background"] != false {
		t.Fatalf("entry = %#v", entry)
	}

	// tool_use adds an active tool
	s.handleSubagentProgress(subagent.SubAgentProgress{ToolCallID: "tc-1", Role: "researcher", Event: agent.ToolUseEvent{ToolID: "tool-1", ToolName: "Bash"}})
	entry = subagents()[0].(map[string]any)
	active := entry["activeTools"].([]any)
	if len(active) != 1 || active[0].(map[string]any)["toolId"] != "tool-1" || active[0].(map[string]any)["toolName"] != "Bash" {
		t.Fatalf("activeTools = %#v", active)
	}

	// turn_complete increments the turn count and clears active tools
	s.handleSubagentProgress(subagent.SubAgentProgress{ToolCallID: "tc-1", Role: "researcher", Event: agent.TurnComplete{Turn: 1}})
	entry = subagents()[0].(map[string]any)
	if entry["turnCount"] != float64(1) || len(entry["activeTools"].([]any)) != 0 {
		t.Fatalf("entry = %#v", entry)
	}

	// finished sets the terminal status
	s.handleSubagentProgress(subagent.SubAgentProgress{ToolCallID: "tc-1", Role: "researcher", Status: "completed"})
	entry = subagents()[0].(map[string]any)
	if entry["status"] != "completed" {
		t.Fatalf("entry = %#v", entry)
	}

	// clear empties the list
	s.clearSubagents()
	if list := subagents(); len(list) != 0 {
		t.Fatalf("list after clear = %#v", list)
	}
}

func TestBroadcastTeammatesEmptyIsStable(t *testing.T) {
	s := NewServer(nil, nil, nil, "", false, 0, nil, true)
	s.teamMgr = teams.NewTeamManager(t.TempDir())
	client := dialClient(t, s)

	// First poll broadcasts the (empty) list; the second is signature-gated.
	s.broadcastTeammates()
	msg := readJSON(t, client)
	if msg["type"] != "teammates" {
		t.Fatalf("type = %v", msg["type"])
	}
	if list := msg["data"].(map[string]any)["list"].([]any); len(list) != 0 {
		t.Fatalf("list = %#v", list)
	}

	s.broadcastTeammates()
	_ = client.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
	var extra map[string]any
	if err := client.ReadJSON(&extra); err == nil {
		t.Fatalf("expected no second broadcast, got %#v", extra)
	}
}

func TestThinkingFormBroadcast(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	s := NewServer([]config.ProviderConfig{{Name: "p", Protocol: "openai", BaseURL: "http://p", Model: "m", Thinking: "low"}}, nil, nil, "", false, 0, nil, true)
	s.cmdRegistry = commands.CreateDefaultRegistry()
	s.sessionID = "sess-thinking"
	client := dialClient(t, s)

	s.runSlashCommand(context.Background(), "/thinking", history.InputEntry{})

	msg := readJSON(t, client)
	if msg["type"] != "thinking_form" {
		t.Fatalf("type = %v, want thinking_form", msg["type"])
	}
	data := msg["data"].(map[string]any)
	if data["current"] != "low" {
		t.Fatalf("current = %v, want provider fallback 'low'", data["current"])
	}
	levels, ok := data["levels"].([]any)
	if !ok || len(levels) == 0 {
		t.Fatalf("levels = %#v", data["levels"])
	}
}

func TestRunUserBashEmptyCommand(t *testing.T) {
	s := NewServer(nil, nil, nil, "", false, 0, nil, true)
	client := dialClient(t, s)
	s.runUserBash(context.Background(), t.TempDir(), "", true, history.InputEntry{})
	msg := readJSON(t, client)
	if msg["type"] != "system" {
		t.Fatalf("type = %v", msg["type"])
	}
	if message := msg["data"].(map[string]any)["message"].(string); !strings.Contains(message, "Enter a Bash command after !!") {
		t.Fatalf("message = %q", message)
	}
}

func TestRunUserBashNoBashTool(t *testing.T) {
	s := NewServer(nil, nil, nil, "", false, 0, nil, true)
	s.registry = tools.NewRegistry()
	client := dialClient(t, s)
	s.runUserBash(context.Background(), t.TempDir(), "echo hi", false, history.InputEntry{})
	msg := readJSON(t, client)
	if msg["type"] != "error" || msg["data"].(map[string]any)["message"] != "Bash tool is unavailable" {
		t.Fatalf("msg = %#v", msg)
	}
}

func TestSkillsCommandNoCatalog(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	s := NewServer(nil, nil, nil, "", false, 0, nil, true)
	s.cmdRegistry = commands.CreateDefaultRegistry()
	s.sessionID = "sess"
	client := dialClient(t, s)
	s.runSlashCommand(context.Background(), "/skills", history.InputEntry{})
	msg := readJSON(t, client)
	if msg["type"] != "system" || msg["data"].(map[string]any)["message"] != "No skills loaded." {
		t.Fatalf("msg = %#v", msg)
	}
}

func TestSandboxCommandStatus(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	s := newBootstrapServer(t)
	s.cmdRegistry = commands.CreateDefaultRegistry()
	s.sessionID = "sess"
	client := dialClient(t, s)
	s.runSlashCommand(context.Background(), "/sandbox", history.InputEntry{})
	msg := readJSON(t, client)
	if msg["type"] != "system" {
		t.Fatalf("type = %v", msg["type"])
	}
	message := msg["data"].(map[string]any)["message"].(string)
	if !strings.Contains(message, "Sandbox status: ON + auto-allow") || !strings.Contains(message, "Usage: /sandbox <mode>") {
		t.Fatalf("message = %q", message)
	}
}

func TestLoginCommandBroadcastsProviderList(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	s, client := newProviderServer(t)
	s.cmdRegistry = commands.CreateDefaultRegistry()
	s.sessionID = "sess"
	s.runSlashCommand(context.Background(), "/login", history.InputEntry{})
	msg := readJSON(t, client)
	if msg["type"] != "provider_list" {
		t.Fatalf("type = %v", msg["type"])
	}
}
