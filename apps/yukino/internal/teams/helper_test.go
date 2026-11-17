package teams

import "testing"

func useTempHome(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("USERPROFILE", dir)
	return dir
}

// createTeamWith registers a pre-built team with the manager for tests that
// exercise manager-level flows without touching the disk layout.
func createTeamWith(mgr *TeamManager, team *Team) {
	mgr.mu.Lock()
	defer mgr.mu.Unlock()
	key := sanitizeTeamName(team.Name)
	if mgr.teams[key] == nil {
		mgr.order = append(mgr.order, key)
	}
	mgr.teams[key] = team
}
