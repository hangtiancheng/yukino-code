package agent

import (
	"testing"
)

func TestActivateAndClearSkills(t *testing.T) {
	a := &Agent{}
	a.ActivateSkill("commit", "do git stuff")
	a.ActivateSkill("review", "audit changes")

	if got := a.GetActiveSkills(); len(got) != 2 {
		t.Errorf("expected 2 active skills, got %d", len(got))
	}

	a.ClearActiveSkills()
	if got := a.GetActiveSkills(); len(got) != 0 {
		t.Errorf("ClearActiveSkills did not empty the map; got %d", len(got))
	}
}
