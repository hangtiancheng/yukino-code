package plan_file

import (
	"os"
	"path/filepath"
	"testing"
)

type testOwner struct{ path string }

func (o *testOwner) CurrentPlanPath() string     { return o.path }
func (o *testOwner) SetPlanFilePath(path string) { o.path = path }
func TestPlanOwnersAreIndependent(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	first, second := &testOwner{}, &testOwner{}
	if err := SavePlan(first, "first plan"); err != nil {
		t.Fatal(err)
	}
	if err := SavePlan(second, "second plan"); err != nil {
		t.Fatal(err)
	}
	if first.path == second.path {
		t.Fatal("plans share a path")
	}
	ResetPlanPath(first)
	if first.path != "" || !PlanExists(second) {
		t.Fatal("reset affected another owner")
	}
	content, err := LoadPlan(second)
	if err != nil || content != "second plan" {
		t.Fatal(content, err)
	}
}
func TestPlanStorageAndCreationErrors(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	outside := filepath.Join(t.TempDir(), "outside.md")
	os.WriteFile(outside, []byte("outside"), 0600)
	owner := &testOwner{path: outside}
	if PlanExists(owner) {
		t.Fatal("accepted outside plan")
	}
	path, err := GetOrCreatePlanPath(owner)
	if err != nil || path == outside || !PlanExists(owner) {
		t.Fatal(path, err)
	}
	other := filepath.Join(t.TempDir(), "broken-home")
	os.WriteFile(other, []byte("file"), 0600)
	t.Setenv("HOME", other)
	missing := &testOwner{}
	if _, err := GetOrCreatePlanPath(missing); err == nil || missing.path != "" {
		t.Fatal("creation failure was swallowed")
	}
}
