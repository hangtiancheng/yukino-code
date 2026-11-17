package ui

import (
	"context"
	"fmt"
	"math"
	"strings"
	"sync"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/yukino-js/yukino/yukino/internal/agent"
	"github.com/yukino-js/yukino/yukino/internal/config"
	"github.com/yukino-js/yukino/yukino/internal/llm"
	"github.com/yukino-js/yukino/yukino/internal/permissions"
	"github.com/yukino-js/yukino/yukino/internal/tools"
	"github.com/yukino-js/yukino/yukino/internal/workflow"
)

type workflowClients struct {
	mu       sync.RWMutex
	client   llm.Client
	provider *config.ProviderConfig
}

func (b *workflowClients) set(client llm.Client, provider *config.ProviderConfig) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.client = client
	if provider != nil {
		p := *provider
		b.provider = &p
	}
}
func (b *workflowClients) getClient() llm.Client { b.mu.RLock(); defer b.mu.RUnlock(); return b.client }
func (b *workflowClients) getProvider() *config.ProviderConfig {
	b.mu.RLock()
	defer b.mu.RUnlock()
	if b.provider == nil {
		return nil
	}
	p := *b.provider
	return &p
}

type workflowConfirm struct {
	runID   string
	agentID *int
}
type workflowActionDoneMsg struct {
	output string
	err    error
}

func (m *Model) attachWorkflow() {
	if m.workflowClients == nil {
		m.workflowClients = &workflowClients{}
	}
	m.workflowClients.set(m.client, m.selectedProvider)
	if m.registry == nil || m.taskMgr == nil {
		return
	}
	service := workflow.AttachWorkflow(workflow.WorkflowServiceOptions{WorkflowBackendOptions: workflow.WorkflowBackendOptions{
		Registry: m.registry, GetClient: m.workflowClients.getClient, GetProvider: m.workflowClients.getProvider}, Cwd: m.getWorkDir(), TaskManager: m.taskMgr})
	_ = service.RegisterNamedCommands(m.cmdRegistry)
	m.registry.AddCleanup(service.Shutdown)
}
func (m Model) workflowContext() context.Context {
	checker := (*permissions.Checker)(nil)
	if m.ag != nil {
		checker = m.ag.Checker
	}
	ch := m.hostPermissionCh
	life := m.lifeCtx
	execution := tools.ExecutionContext{WorkDir: m.getWorkDir(), TaskManager: m.taskMgr, SessionID: m.sessionID}
	if checker != nil {
		execution.Worktrees = checker
		execution.Plan = &tools.PlanContext{Owner: checker, IsPlanMode: func() bool { return checker.Mode() == permissions.ModePlan }, EnterPlanMode: func() { checker.EnterPlanMode() }}
	}
	execution.RequestPermission = func(ctx context.Context, request tools.PermissionRequest) int {
		response := make(chan agent.PermissionReply, 1)
		event := agent.PermissionRequestEvent{Context: ctx, AgentName: request.AgentName, Cwd: request.Cwd, ToolName: request.ToolName, ToolID: request.ToolCallID, Args: request.Args, Desc: request.Desc, Decision: permissions.Decision{RememberPatterns: request.RememberPatterns}, ResponseCh: response}
		select {
		case ch <- event:
		case <-ctx.Done():
			return int(agent.PermDeny)
		case <-life.Done():
			return int(agent.PermDeny)
		}
		select {
		case reply := <-response:
			return int(reply.Response)
		case <-ctx.Done():
			return int(agent.PermDeny)
		case <-life.Done():
			return int(agent.PermDeny)
		}
	}
	return tools.WithExecutionContext(m.lifeCtx, execution)
}
func (m Model) openWorkflowsDialog() (tea.Model, tea.Cmd) {
	service := workflow.GetWorkflowService(m.registry)
	if service == nil {
		return m, nil
	}
	m.workflowsDialog = true
	m.workflowRunCursor = 0
	m.workflowAgentCursor = 0
	m.workflowError = ""
	m.workflowConfirm = nil
	return m, func() tea.Msg { return workflowActionDoneMsg{err: service.LoadPersistedRuns()} }
}
func (m Model) workflowRuns() []*workflow.WorkflowRun {
	service := workflow.GetWorkflowService(m.registry)
	if service == nil {
		return nil
	}
	runs := service.Store.GetSnapshot()
	return runs[:min(len(runs), workflow.MaxVisibleRuns)]
}
func (m Model) handleWorkflowsDialog(key tea.KeyMsg) (tea.Model, tea.Cmd) {
	service := workflow.GetWorkflowService(m.registry)
	if service == nil {
		m.workflowsDialog = false
		return m, nil
	}
	if confirm := m.workflowConfirm; confirm != nil {
		switch strings.ToLower(key.String()) {
		case "y", "enter":
			if confirm.agentID != nil {
				service.KillAgent(confirm.runID, *confirm.agentID)
			} else {
				if _, err := service.Kill(confirm.runID); err != nil {
					m.workflowError = err.Error()
				}
			}
			m.workflowConfirm = nil
		case "n", "esc":
			m.workflowConfirm = nil
		}
		return m, nil
	}
	if key.String() == "esc" || key.String() == "q" {
		m.workflowsDialog = false
		return m, nil
	}
	runs := m.workflowRuns()
	if len(runs) == 0 {
		return m, nil
	}
	runIndex := min(m.workflowRunCursor, len(runs)-1)
	run := runs[runIndex]
	agentIndex := min(m.workflowAgentCursor, max(0, len(run.Agents)-1))
	switch key.String() {
	case "tab", "shift+tab":
		direction := 1
		if key.String() == "shift+tab" {
			direction = -1
		}
		m.workflowRunCursor = (runIndex + direction + len(runs)) % len(runs)
		m.workflowAgentCursor = 0
	case "up":
		m.workflowAgentCursor = max(0, agentIndex-1)
	case "down":
		m.workflowAgentCursor = min(max(0, len(run.Agents)-1), agentIndex+1)
	case "K":
		if run.Status == "running" {
			m.workflowConfirm = &workflowConfirm{runID: run.RunID}
		}
	case "x":
		if len(run.Agents) > 0 && run.Agents[agentIndex].Status == "running" {
			id := run.Agents[agentIndex].ID
			m.workflowConfirm = &workflowConfirm{runID: run.RunID, agentID: &id}
		}
	case "r":
		if run.Status != "running" && !m.workflowResuming {
			m.workflowResuming = true
			m.workflowError = ""
			ctx, id := m.workflowContext(), run.RunID
			return m, func() tea.Msg {
				_, err := service.Launch(map[string]any{"resumeFromRunId": id}, ctx)
				return workflowActionDoneMsg{err: err}
			}
		}
	}
	return m, nil
}
func workflowStatusColor(status string) string {
	switch status {
	case "running":
		return Theme.Accent
	case "completed", "done", "ok":
		return Theme.Success
	case "failed", "dead":
		return Theme.Error
	case "killed", "cancelled", "skipped":
		return Theme.Warning
	}
	return Theme.Dim
}
func workflowStatusIcon(status string) string {
	switch status {
	case "running":
		return "●"
	case "completed", "done", "ok":
		return "✓"
	case "failed", "dead":
		return "✗"
	case "killed", "cancelled", "skipped":
		return "–"
	}
	return "○"
}
func (m Model) renderWorkflowsDialog() string {
	runs := m.workflowRuns()
	rows := m.dialogAvailableRows()
	width := max(1, m.width-boolColumn(m.width > 2)*2)
	wide := m.width >= 65
	hint := workflow.WorkflowPanelCompactHint
	if wide {
		hint = workflow.WorkflowPanelHint
	}
	if m.workflowConfirm != nil {
		hint = "Stop selected work? y/Enter confirm · n/Esc cancel"
	}
	subtitle := workflow.WorkflowPanelEmpty
	var lines []string
	if len(runs) > 0 {
		runIndex := min(m.workflowRunCursor, len(runs)-1)
		run := runs[runIndex]
		agentIndex := min(m.workflowAgentCursor, max(0, len(run.Agents)-1))
		subtitle = run.WorkflowName + " · " + run.Status + " · " + run.RunID
		contentRows := max(0, rows-selectorChrome(rows, true).height)
		roomy := contentRows >= 10
		notices := boolColumn(run.Error != "") + boolColumn(m.workflowError != "") + boolColumn(m.workflowResuming) + boolColumn(len(run.Logs) > 0)
		rowHeight := 1
		if !wide && contentRows-3-notices >= 2 {
			rowHeight = 2
		}
		count := max(1, (contentRows-3-boolColumn(roomy)-notices)/rowHeight)
		agentWidth := width
		agentTextWidth := width
		phaseWidth := 0
		if wide {
			phaseWidth = int(math.Round(float64(width) * .3))
			agentWidth -= phaseWidth
			// Ink measures fractional text widths upward before clipping to the rounded box.
			agentTextWidth = int(math.Ceil(float64(width) * .7))
		}
		start := getListWindowStart(len(run.Agents), agentIndex, count)
		phaseRows := count * rowHeight
		phaseFocus := 0
		for i, phase := range run.Phases {
			if phase.Status == "running" {
				phaseFocus = i
				break
			}
		}
		phaseStart := getListWindowStart(len(run.Phases), phaseFocus, phaseRows)
		tabCount := max(1, (m.width-2)/24)
		tabStart := getListWindowStart(len(runs), runIndex, tabCount)
		tabWidth := max(1, (m.width-2)/min(tabCount, max(1, len(runs))))
		tabs := ""
		for i := tabStart; i < min(len(runs), tabStart+tabCount); i++ {
			label := truncateToWidth(fmt.Sprintf(" %d %s ", i+1, plainTerminalLine(runs[i].WorkflowName)), tabWidth, "…")
			if i == runIndex {
				label = ansiStyle(label, "\x1b[1m", "\x1b[22m")
				label = lipgloss.NewStyle().Background(lipgloss.Color(Theme.SelectedBg)).Width(tabWidth).Render(paint(label, Theme.Accent))
			} else {
				label = paint(label, Theme.Muted) + strings.Repeat(" ", max(0, tabWidth-visibleWidth(label)))
			}
			tabs += label
		}
		lines = append(lines, tabs)
		done := 0
		for _, phase := range run.Phases {
			if phase.Status == "done" {
				done++
			}
		}
		lines = append(lines, paint(workflowStatusIcon(run.Status)+" "+run.Status, workflowStatusColor(run.Status))+paint(fmt.Sprintf(" · %d/%d phases · %d agents", done, len(run.Phases), len(run.Agents)), Theme.Muted))
		if roomy {
			lines = append(lines, "")
		}
		agentCount := "0"
		if len(run.Agents) > 0 {
			agentCount = fmt.Sprintf("%d/%d", agentIndex+1, len(run.Agents))
		}
		agentHeading := paint("Agents ", Theme.CustomMessageLabel) + paint(agentCount, Theme.Dim)
		agentLines := []string{ansiStyle(agentHeading, "\x1b[1m", "\x1b[22m")}
		if len(run.Agents) == 0 {
			agentLines = append(agentLines, paint("No agents yet", Theme.Dim))
		}
		for i := start; i < min(len(run.Agents), start+count); i++ {
			a := run.Agents[i]
			status := a.ResultKind
			if status == "" {
				status = a.Status
			}
			prefix, color := "  ", Theme.Dim
			if i == agentIndex {
				prefix, color = "› ", Theme.Accent
			}
			label := a.Label
			if label == "" {
				label = a.Phase
			}
			if label == "" {
				label = "agent"
			}
			name := fmt.Sprintf("#%d %s", a.ID, plainTerminalLine(label))
			nameColor := Theme.Text
			if i == agentIndex {
				name = ansiStyle(name, "\x1b[1m", "\x1b[22m")
				nameColor = Theme.Accent
			}
			line := paint(prefix, color) + paint(workflowStatusIcon(status)+" ", workflowStatusColor(status)) + paint(name, nameColor)
			stats := fmt.Sprintf("%s · %d tokens · %d tools", status, a.TokenCount, a.ToolCount)
			if rowHeight == 1 {
				line += paint(" · "+stats, Theme.Muted)
			}
			line = truncateToWidth(truncateToWidth(line, agentTextWidth, "…"), agentWidth, "")
			if i == agentIndex {
				line = renderPanel(line, agentWidth, 0, Theme.SelectedBg, Theme.Text)
			}
			agentLines = append(agentLines, line)
			if rowHeight == 2 {
				line = paint(truncateToWidth(truncateToWidth(" "+stats, agentTextWidth, "…"), agentWidth, ""), Theme.Muted)
				if i == agentIndex {
					line = renderPanel(line, agentWidth, 0, Theme.SelectedBg, Theme.Muted)
				}
				agentLines = append(agentLines, line)
			}
		}
		if wide {
			phaseLines := []string{ansiStyle(paint("Phases", Theme.CustomMessageLabel), "\x1b[1m", "\x1b[22m")}
			if len(run.Phases) == 0 {
				phaseLines = append(phaseLines, paint("No phases yet", Theme.Dim))
			}
			for _, phase := range run.Phases[phaseStart:min(len(run.Phases), phaseStart+phaseRows)] {
				color := Theme.Text
				if phase.Status == "pending" {
					color = Theme.Dim
				}
				phaseLines = append(phaseLines, paint(workflowStatusIcon(phase.Status)+" ", workflowStatusColor(phase.Status))+paint(plainTerminalLine(phase.Title), color))
			}
			for i := 0; i < max(len(agentLines), len(phaseLines)); i++ {
				left, right := "", ""
				if i < len(phaseLines) {
					left = truncateToWidth(phaseLines[i], max(0, phaseWidth-2), "…")
				}
				if i < len(agentLines) {
					right = agentLines[i]
				}
				lines = append(lines, left+strings.Repeat(" ", max(0, phaseWidth-visibleWidth(left)))+truncateToWidth(right, max(1, width-phaseWidth), "…"))
			}
		} else {
			lines = append(lines, agentLines...)
		}
		if run.Error != "" {
			lines = append(lines, paint(plainTerminalLine(run.Error), Theme.Error))
		}
		if len(run.Logs) > 0 {
			lines = append(lines, paint(plainTerminalLine(run.Logs[len(run.Logs)-1]), Theme.Dim))
		}
	} else {
		lines = append(lines, wrapTerminalTextOptions(paint(workflow.WorkflowPanelEmpty, Theme.Muted), width, true, false)...)
	}
	if m.workflowResuming {
		lines = append(lines, paint("Resuming workflow…", Theme.Accent))
	}
	if m.workflowError != "" {
		lines = append(lines, paint(plainTerminalLine(m.workflowError), Theme.Error))
	}
	for i, line := range lines {
		lines[i] = truncateToWidth(line, width, "…")
	}
	return m.renderSelectorFrame(selectorFrameParams{title: workflow.WorkflowPanelTitle, subtitle: subtitle, hint: hint, content: strings.Join(lines, "\n"), width: m.width, rows: rows, scrollKey: "workflows"})
}
