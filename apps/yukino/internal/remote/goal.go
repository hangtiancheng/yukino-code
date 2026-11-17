package remote

import (
	"os"

	"github.com/yukino-js/yukino/yukino/internal/goal"
)

// goal mirrors the reference AgentHandleImpl.goalManager getter: it lazily
// (re)creates the goal manager keyed on the active session so a resume or reset
// reloads goal state from the correct transcript.
func (s *Server) goal() *goal.GoalManager {
	if s.goalManager == nil || s.goalManager.SessionID() != s.sessionID {
		wd, _ := os.Getwd()
		s.goalManager = goal.NewGoalManager(wd, s.sessionID)
	}
	return s.goalManager
}
