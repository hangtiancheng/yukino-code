package workflow

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/yukino-js/yukino/yukino/internal/subagent"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

func newTestService(t *testing.T) (*WorkflowService, *subagent.TaskManager, string) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	cwd := t.TempDir()
	taskMgr := subagent.NewTaskManager()
	if err := taskMgr.UseSession("service-test"); err != nil {
		t.Fatal(err)
	}
	service := NewWorkflowService(WorkflowServiceOptions{
		WorkflowBackendOptions: WorkflowBackendOptions{Registry: tools.NewRegistry()},
		Cwd:                    cwd,
		TaskManager:            taskMgr,
	})
	return service, taskMgr, cwd
}

func waitForRun(t *testing.T, service *WorkflowService, runID, status string) *WorkflowRun {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		run := service.Store.Get(runID)
		if run != nil && run.Status == status {
			return run
		}
		if time.Now().After(deadline) {
			if run == nil {
				t.Fatalf("run %s never appeared", runID)
			}
			t.Fatalf("run %s status = %s, want %s (error %q)", runID, run.Status, status, run.Error)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestServiceLaunchCompletes(t *testing.T) {
	service, taskMgr, _ := newTestService(t)
	defer taskMgr.StopAll(context.Background())

	launch, err := service.Launch(map[string]any{
		"script":      "export const meta = { name: 'svc', description: 'd' }\nreturn 21 * 2",
		"description": "compute answer",
	}, context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if launch.WorkflowName != "svc" || launch.TaskID == "" || !strings.HasSuffix(launch.ScriptPath, ScriptFilename) {
		t.Fatalf("launch = %#v", launch)
	}
	run := waitForRun(t, service, launch.RunID, "completed")
	if run.ReturnValue != int64(42) && run.ReturnValue != 42 {
		t.Errorf("returnValue = %#v", run.ReturnValue)
	}
	if run.TaskID != launch.TaskID || run.Status != "completed" {
		t.Errorf("run = %#v", run)
	}

	// The formatted result lists the run.
	listing, err := service.Command("", context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(listing, launch.RunID) || !strings.Contains(listing, "svc | completed") {
		t.Errorf("listing = %q", listing)
	}
	detail, err := service.Command(launch.RunID, context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(detail, "status: completed") || !strings.Contains(detail, "42") {
		t.Errorf("detail = %q", detail)
	}
}

func TestServiceLaunchValidation(t *testing.T) {
	service, taskMgr, _ := newTestService(t)
	defer taskMgr.StopAll(context.Background())

	if _, err := service.Launch(map[string]any{}, context.Background()); err == nil ||
		!strings.Contains(err.Error(), "Provide exactly one") {
		t.Errorf("no source err = %v", err)
	}
	if _, err := service.Launch(map[string]any{"script": "return 1", "name": "x"}, context.Background()); err == nil {
		t.Error("two sources must fail")
	}
	if _, err := service.Launch(map[string]any{"name": "missing-flow"}, context.Background()); err == nil ||
		!strings.Contains(err.Error(), "not found") {
		t.Errorf("missing named workflow err = %v", err)
	}
}

func TestServiceNamedWorkflowAndCommands(t *testing.T) {
	service, taskMgr, cwd := newTestService(t)
	defer taskMgr.StopAll(context.Background())

	dir := cwd + "/.yukino/workflows"
	if err := mkdirAll(dir); err != nil {
		t.Fatal(err)
	}
	if err := writeFile(dir+"/greet.js", "return 'hi ' + (args.who || 'world')"); err != nil {
		t.Fatal(err)
	}

	launch, err := service.Launch(map[string]any{"name": "greet", "args": map[string]any{"who": "yukino"}}, context.Background())
	if err != nil {
		t.Fatal(err)
	}
	run := waitForRun(t, service, launch.RunID, "completed")
	if run.ReturnValue != "hi yukino" {
		t.Errorf("returnValue = %#v", run.ReturnValue)
	}

	// Named commands register as prompt commands.
	registry := newTestCommandRegistry()
	if err := service.RegisterNamedCommands(registry); err != nil {
		t.Fatal(err)
	}
	if !registry.Has("greet") {
		t.Error("greet command not registered")
	}
	prompt := registry.Prompts()["greet"]
	if !strings.Contains(prompt, `Run the named workflow "greet"`) {
		t.Errorf("prompt = %q", prompt)
	}

	// stop on a finished run reports not running.
	message, err := service.Command("stop "+launch.RunID, context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(message, "is not running") {
		t.Errorf("stop message = %q", message)
	}
	if killed, err := service.Kill("unknown-run"); killed || err != nil {
		t.Error("kill of unknown run must be false")
	}
	if service.KillAgent("unknown-run", 0) {
		t.Error("killAgent of unknown run must be false")
	}
}

func TestServiceResumeReusesSavedScript(t *testing.T) {
	service, taskMgr, _ := newTestService(t)
	defer taskMgr.StopAll(context.Background())

	first, err := service.Launch(map[string]any{"script": "throw new Error('first attempt fails')"}, context.Background())
	if err != nil {
		t.Fatal(err)
	}
	waitForRun(t, service, first.RunID, "failed")
	// Resume with the saved run id but an overridden source.
	second, err := service.Launch(map[string]any{"resumeFromRunId": first.RunID, "script": "return 'resumed'"}, context.Background())
	if err != nil {
		t.Fatal(err)
	}
	run := waitForRun(t, service, second.RunID, "completed")
	if run.ReturnValue != "resumed" {
		t.Errorf("returnValue = %#v", run.ReturnValue)
	}
}

func TestServiceLoadPersistedRunsMarksInterrupted(t *testing.T) {
	service, taskMgr, _ := newTestService(t)
	launch, err := service.Launch(map[string]any{"script": "return 'persisted'"}, context.Background())
	if err != nil {
		t.Fatal(err)
	}
	waitForRun(t, service, launch.RunID, "completed")
	_ = taskMgr.StopAll(context.Background())

	// A fresh service over the same cwd loads the persisted state.
	service2 := NewWorkflowService(WorkflowServiceOptions{
		WorkflowBackendOptions: WorkflowBackendOptions{Registry: tools.NewRegistry()},
		Cwd:                    service.options.Cwd,
		TaskManager:            taskMgr,
	})
	if err := service2.LoadPersistedRuns(); err != nil {
		t.Fatal(err)
	}
	run := service2.Store.Get(launch.RunID)
	if run == nil || run.Status != "completed" {
		t.Fatalf("persisted run = %#v", run)
	}

	// Simulate an interrupted run: rewrite the state as running and reload.
	broken := *run
	broken.Status = "running"
	broken.Agents = []WorkflowRunAgent{{ID: 0, Status: "running"}}
	if err := service2.Persistence.WriteState(&broken); err != nil {
		t.Fatal(err)
	}
	service3 := NewWorkflowService(WorkflowServiceOptions{
		WorkflowBackendOptions: WorkflowBackendOptions{Registry: tools.NewRegistry()},
		Cwd:                    service.options.Cwd,
		TaskManager:            taskMgr,
	})
	if err := service3.LoadPersistedRuns(); err != nil {
		t.Fatal(err)
	}
	loaded := service3.Store.Get(launch.RunID)
	if loaded.Status != "killed" || loaded.Error != "Workflow interrupted before shutdown" {
		t.Errorf("interrupted run = %#v", loaded)
	}
	if loaded.Agents[0].Status != "cancelled" {
		t.Errorf("interrupted agent = %#v", loaded.Agents[0])
	}
}

func TestServiceShutdown(t *testing.T) {
	service, taskMgr, _ := newTestService(t)
	defer taskMgr.StopAll(context.Background())
	if err := service.Shutdown(); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Launch(map[string]any{"script": "return 1"}, context.Background()); err == nil ||
		!strings.Contains(err.Error(), "closed") {
		t.Errorf("launch after shutdown err = %v", err)
	}
}

func mkdirAll(path string) error           { return os.MkdirAll(path, 0o755) }
func writeFile(path, content string) error { return os.WriteFile(path, []byte(content), 0o644) }

type testCommandRegistry struct {
	prompts map[string]func(args string) string
}

func newTestCommandRegistry() *testCommandRegistry {
	return &testCommandRegistry{prompts: map[string]func(args string) string{}}
}

func (r *testCommandRegistry) Has(name string) bool {
	_, ok := r.prompts[name]
	return ok
}

func (r *testCommandRegistry) RegisterPromptCommand(name, description string, handler func(args string) string) {
	r.prompts[name] = handler
}

func (r *testCommandRegistry) Prompts() map[string]string {
	out := map[string]string{}
	for name, handler := range r.prompts {
		out[name] = handler("")
	}
	return out
}
