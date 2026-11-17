package teams

import (
	"os"
	"path/filepath"
	"testing"
)

func TestTeamFileRoundTrip(t *testing.T) {
	useTempHome(t)

	tm := NewTeamManager(t.TempDir())
	team := createTestTeamFull(t, tm, "Refactor Auth", "lead", "refactor the auth module")
	if _, err := team.AddMember("alice"); err != nil {
		t.Fatal(err)
	}
	team.SetMemberMeta("alice", "worker", "claude-sonnet-4-6", "/tmp/wt/alice")

	fresh := NewTeamManager(tm.cwd)
	got := fresh.GetTeam("Refactor Auth")
	if got == nil {
		t.Fatal("expected the team to be rebuilt from disk, got nil")
	}
	if got.LeadAgentID != "lead" {
		t.Errorf("LeadAgentID = %q, want lead", got.LeadAgentID)
	}
	if got.Description != "refactor the auth module" {
		t.Errorf("Description = %q, want refactor the auth module", got.Description)
	}
	m, ok := got.Members["alice"]
	if !ok {
		t.Fatalf("member alice was not restored, members: %v", got.Members)
	}
	if m.AgentType != "worker" || m.Model != "claude-sonnet-4-6" || m.WorktreePath != "/tmp/wt/alice" {
		t.Errorf("member metadata mismatch: %+v", m)
	}
}

func TestTeamFilePathIsSanitized(t *testing.T) {
	useTempHome(t)

	cwd := t.TempDir()
	tm := NewTeamManager(cwd)
	createTestTeamFull(t, tm, "Refactor Auth!", "lead", "")

	want := filepath.Join(TeamsBaseDir(cwd), "refactor-auth-", "config.json")
	if _, err := os.Stat(want); err != nil {
		t.Fatalf("expected the config at %s, stat failed: %v", want, err)
	}
}

// TestReadTeamFileRejectsInvalidDocuments pins the strict schema validation
// (TeamFileSchema.parse parity): a missing or wrongly typed required field
// makes the document read as "team not found".
func TestReadTeamFileRejectsInvalidDocuments(t *testing.T) {
	useTempHome(t)
	cwd := t.TempDir()
	dir := filepath.Join(TeamsBaseDir(cwd), "team")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, TeamConfigFilename)
	cases := map[string]string{
		"missing name":            `{"createdAt":1,"leaderAgentId":"l","permissionMode":"default","members":[]}`,
		"wrong createdAt type":    `{"name":"T","createdAt":"1","leaderAgentId":"l","permissionMode":"default","members":[]}`,
		"missing leaderAgentId":   `{"name":"T","createdAt":1,"permissionMode":"default","members":[]}`,
		"bad permissionMode":      `{"name":"T","createdAt":1,"leaderAgentId":"l","permissionMode":"yolo","members":[]}`,
		"missing members":         `{"name":"T","createdAt":1,"leaderAgentId":"l","permissionMode":"default"}`,
		"member missing isActive": `{"name":"T","createdAt":1,"leaderAgentId":"l","permissionMode":"default","members":[{"agentId":"a","name":"alice","joinedAt":1}]}`,
		"member wrong joinedAt":   `{"name":"T","createdAt":1,"leaderAgentId":"l","permissionMode":"default","members":[{"agentId":"a","name":"alice","joinedAt":"1","isActive":true}]}`,
		"member wrong agentType":  `{"name":"T","createdAt":1,"leaderAgentId":"l","permissionMode":"default","members":[{"agentId":"a","name":"alice","joinedAt":1,"isActive":true,"agentType":3}]}`,
		"null description":        `{"name":"T","description":null,"createdAt":1,"leaderAgentId":"l","permissionMode":"default","members":[]}`,
	}
	for name, doc := range cases {
		if err := os.WriteFile(path, []byte(doc), 0o600); err != nil {
			t.Fatal(err)
		}
		if got := ReadTeamFileAtPath(path); got != nil {
			t.Errorf("%s: expected nil, got %+v", name, got)
		}
	}
	valid := `{"name":"Team","createdAt":1700000000,"leaderAgentId":"lead","permissionMode":"default","members":[{"agentId":"a","name":"alice","joinedAt":1700000000,"isActive":false}]}`
	if err := os.WriteFile(path, []byte(valid), 0o600); err != nil {
		t.Fatal(err)
	}
	got := ReadTeamFileAtPath(path)
	if got == nil || got.Name != "Team" || len(got.Members) != 1 || got.Members[0].IsActive {
		t.Fatalf("valid document rejected: %+v", got)
	}
}

// TestTeamFileSnapshotOrderAndAgentIDFallback pins the reference snapshot():
// insertion-ordered member serialization and the agentId ?? name fallback.
func TestTeamFileSnapshotOrderAndAgentIDFallback(t *testing.T) {
	team := &Team{Name: "T", Members: map[string]*Member{}, CreatedAt: 5}
	for _, name := range []string{"zoe", "alice", "mid"} {
		team.Members[name] = &Member{Name: name, JoinedAt: 1}
		team.memberOrder = append(team.memberOrder, name)
	}
	team.Members["alice"].AgentID = "alice-id"
	snap := team.snapshot()
	if len(snap.Members) != 3 {
		t.Fatalf("members = %+v", snap.Members)
	}
	for i, want := range []string{"zoe", "alice", "mid"} {
		if snap.Members[i].Name != want {
			t.Fatalf("order[%d] = %q, want %q", i, snap.Members[i].Name, want)
		}
	}
	if snap.Members[0].AgentID != "zoe" || snap.Members[1].AgentID != "alice-id" {
		t.Fatalf("agentId fallback mismatch: %+v", snap.Members)
	}
	if snap.CreatedAt != 5 {
		t.Fatalf("CreatedAt = %d, want the team's own 5", snap.CreatedAt)
	}
}

func TestDeleteTeamRemovesDir(t *testing.T) {
	useTempHome(t)

	cwd := t.TempDir()
	tm := NewTeamManager(cwd)
	createTestTeamFull(t, tm, "gone", "lead", "")
	if _, err := os.Stat(teamDir(cwd, "gone")); err != nil {
		t.Fatalf("the directory must exist after creating the team: %v", err)
	}

	tm.DeleteTeam("gone")
	if _, err := os.Stat(teamDir(cwd, "gone")); !os.IsNotExist(err) {
		t.Errorf("the directory must be removed after deleting the team, err = %v", err)
	}
	if fresh := NewTeamManager(cwd).GetTeam("gone"); fresh != nil {
		t.Errorf("a deleted team must not be recoverable from disk")
	}
}

func TestGetTeamMissingReturnsNil(t *testing.T) {
	useTempHome(t)
	if got := NewTeamManager(t.TempDir()).GetTeam("never-existed"); got != nil {
		t.Errorf("a nonexistent team should return nil, got %+v", got)
	}
}
