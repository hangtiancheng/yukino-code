package tools

import (
	"context"
	"runtime"

	"github.com/yukino-js/yukino/yukino/internal/sandbox"
)

type PowerShellTool struct {
	TaskManager BackgroundTaskManager
	state       shellState
}

func (t *PowerShellTool) Name() string           { return "PowerShell" }
func (t *PowerShellTool) Description() string    { return PowerShellDescription }
func (t *PowerShellTool) Category() ToolCategory { return CategoryCommand }
func (t *PowerShellTool) Schema() map[string]any {
	return shellSchema(t.Name(), t.Description(), "PowerShell command to execute", PowerShellBackgroundDescription, t.TaskManager != nil)
}
func (t *PowerShellTool) HasForegroundTasks() bool       { return t.state.hasForeground() }
func (t *PowerShellTool) BackgroundForegroundTasks() int { return t.state.backgroundForeground() }
func (t *PowerShellTool) Execute(ctx context.Context, args map[string]any) ToolResult {
	return executeShell(ctx, t.Name(), "PS> ", args, t.TaskManager, &t.state, "", func(command, cwd, outputDir string) (sandbox.PreparedCommand, error) {
		shell := "pwsh"
		arguments := []string{"-NoProfile", "-NonInteractive", "-Command", command}
		if runtime.GOOS == "windows" {
			shell = "powershell.exe"
			arguments = []string{"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n" + command}
		}
		return sandbox.PreparedCommand{Executable: shell, Args: arguments}, nil
	})
}
func AttachBackgroundTaskManager(registry *Registry, manager BackgroundTaskManager) {
	if tool, ok := registry.Get("TaskOutput").(*TaskOutputTool); ok {
		tool.TaskManager = manager
	}
	if tool, ok := registry.Get("Bash").(*BashTool); ok {
		tool.TaskManager = manager
	}
	if tool, ok := registry.Get("PowerShell").(*PowerShellTool); ok {
		tool.TaskManager = manager
	}
}
func HasAnyForegroundTasks(registry *Registry) bool {
	for _, name := range []string{"Bash", "PowerShell"} {
		if tool, ok := registry.Get(name).(interface{ HasForegroundTasks() bool }); ok && tool.HasForegroundTasks() {
			return true
		}
	}
	return false
}
func BackgroundAllForegroundTasks(registry *Registry) int {
	count := 0
	for _, name := range []string{"Bash", "PowerShell"} {
		if tool, ok := registry.Get(name).(interface{ BackgroundForegroundTasks() int }); ok {
			count += tool.BackgroundForegroundTasks()
		}
	}
	return count
}
