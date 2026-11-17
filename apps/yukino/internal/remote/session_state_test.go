package remote

import (
	"testing"

	"github.com/yukino-js/yukino/yukino/internal/agent"
	"github.com/yukino-js/yukino/yukino/internal/compact"
	"github.com/yukino-js/yukino/yukino/internal/conversation"
	"github.com/yukino-js/yukino/yukino/internal/file_history"
	"github.com/yukino-js/yukino/yukino/internal/permissions"
	"github.com/yukino-js/yukino/yukino/internal/todo"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

func TestRestoreSessionResetsPerSessionState(t *testing.T) {
	wd := t.TempDir()
	s := newPendingServer()
	s.conv = conversation.NewManager()
	s.conv.AddUserMessage("stale transcript")
	s.defaultTools = tools.CreateDefaultToolsWithWorkDir(wd)
	s.fileHistory = file_history.New("old-session")
	s.defaultTools.EditFile.FileHistory = s.fileHistory
	s.defaultTools.WriteFile.FileHistory = s.fileHistory

	oldStore, err := todo.NewStore("old-session")
	if err != nil {
		t.Fatal(err)
	}
	s.todoList, err = todo.NewTaskList(oldStore)
	if err != nil {
		t.Fatal(err)
	}

	ag := &agent.Agent{
		Checker:        permissions.NewChecker(permissions.NewPathSandbox(wd, true), permissions.NewRuleEngine(wd), permissions.ModeDefault),
		FileHistory:    s.fileHistory,
		FileStateCache: tools.NewFileStateCache(),
		RecoveryState:  compact.NewRecoveryState(),
	}
	ag.SetSessionID("old-session")
	ag.ActivateSkill("demo", "body")
	ag.Checker.SetPlanFilePath(wd + "/plan.md")
	ag.SetToolFilter(func(string) bool { return false })
	s.ag = ag

	oldHistory := s.fileHistory
	oldCache := ag.FileStateCache
	oldRecovery := ag.RecoveryState

	if err := s.restoreSession("new-session", []conversation.Message{{Role: "user", Content: "restored transcript"}}); err != nil {
		t.Fatal(err)
	}

	if s.sessionID != "new-session" || ag.SessionID != "new-session" {
		t.Fatalf("session id not rotated: server=%q agent=%q", s.sessionID, ag.SessionID)
	}
	if messages := s.conv.GetMessages(); len(messages) != 1 || messages[0].Content != "restored transcript" {
		t.Fatalf("conversation was not replaced with replay: %#v", messages)
	}
	if s.fileHistory == oldHistory {
		t.Fatal("file history was not recreated")
	}
	if ag.FileHistory != s.fileHistory || s.defaultTools.EditFile.FileHistory != s.fileHistory || s.defaultTools.WriteFile.FileHistory != s.fileHistory {
		t.Fatal("file history was not rebound to the agent and edit/write tools")
	}
	if ag.FileStateCache == nil || ag.FileStateCache == oldCache {
		t.Fatal("file state cache was not reset")
	}
	if ag.RecoveryState == nil || ag.RecoveryState == oldRecovery {
		t.Fatal("recovery state was not reset")
	}
	if len(ag.GetActiveSkills()) != 0 {
		t.Fatalf("active skills were not cleared: %v", ag.GetActiveSkills())
	}
	if ag.Checker.CurrentPlanPath() != "" {
		t.Fatalf("plan file path was not cleared: %q", ag.Checker.CurrentPlanPath())
	}
	if ag.ToolNameFilter != nil {
		t.Fatal("tool filter was not reset to the coordinator base (nil when coordinator mode is off)")
	}
	if got := s.todoList.BoardID(); got != "private:new-session" {
		t.Fatalf("task list store not switched: %q", got)
	}
}
