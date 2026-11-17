package teams

import (
	"math"
	"strconv"
	"sync"
	"time"
	"unicode/utf16"

	"github.com/yukino-js/yukino/yukino/internal/utils"
)

const (
	// MaxRecentActivities mirrors MAX_RECENT_ACTIVITIES: the cap on retained
	// recent-activity history per teammate.
	MaxRecentActivities = 5
	// MaxLastMessageChars mirrors MAX_LAST_MESSAGE_CHARS: the truncation limit
	// for the last-message preview shown in the teammate UI.
	MaxLastMessageChars = 200
)

type ToolActivity struct {
	Input       map[string]any
	ToolName    string
	Description string
}

func NewToolActivity(toolName string, input map[string]interface{}) ToolActivity {
	return ToolActivity{
		Input:       input,
		ToolName:    toolName,
		Description: describeActivity(toolName, input),
	}
}

func describeActivity(toolName string, input map[string]interface{}) string {
	getStr := func(key, fallback string) string { return utils.StrArg(input, key, fallback) }

	switch toolName {
	case "ReadFile":
		return "Reading " + getStr("file_path", "file")
	case "EditFile":
		return "Editing " + getStr("file_path", "file")
	case "WriteFile":
		return "Writing " + getStr("file_path", "file")
	case "Bash", "PowerShell":
		cmd := getStr("command", "")
		if units := utf16.Encode([]rune(cmd)); len(units) > 40 {
			cmd = string(utf16.Decode(units[:40])) + "..."
		}
		return "Running " + cmd
	case "Glob":
		return "Searching " + getStr("pattern", "files")
	case "Grep":
		return "Grepping " + getStr("pattern", "pattern")
	case "WebFetch":
		return "Fetching " + getStr("url", "page")
	default:
		return toolName
	}
}

type TeammateProgress struct {
	mu               sync.Mutex
	OriginToolCallID string
	Name             string
	TeamName         string
	Status           string
	TurnCount        int
	ActiveTools      []ActiveTool
	ToolUseCount     int
	TokenCount       int64
	LastActivity     *ToolActivity
	RecentActivities []ToolActivity
	SpinnerVerb      string
	StartTime        int64
	LastMessage      string
}

func NewTeammateProgress(name, teamName, spinnerVerb string) *TeammateProgress {
	return &TeammateProgress{
		Name:        name,
		TeamName:    teamName,
		Status:      "running",
		SpinnerVerb: spinnerVerb,
		StartTime:   time.Now().UnixMilli(),
	}
}

func (p *TeammateProgress) RecordToolUse(toolName string, input map[string]interface{}) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.ToolUseCount++
	act := NewToolActivity(toolName, input)
	p.LastActivity = &act
	p.RecentActivities = append(p.RecentActivities, act)
	if len(p.RecentActivities) > MaxRecentActivities {
		p.RecentActivities = p.RecentActivities[1:]
	}
}

func (p *TeammateProgress) RecordTokens(input, output int64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.TokenCount += input + output
}

func (p *TeammateProgress) SetStatus(s string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.Status = s
}

func (p *TeammateProgress) GetStatus() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.Status
}

func (p *TeammateProgress) ActivitySummary() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.LastActivity != nil {
		return p.LastActivity.Description
	}
	return p.SpinnerVerb
}

// TeammateSpinnerVerb mirrors TEAMMATE_SPINNER_VERB in the reference.
const TeammateSpinnerVerb = "Working"

func (p *TeammateProgress) GetToolUseCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.ToolUseCount
}

func (p *TeammateProgress) GetTokenCount() int64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.TokenCount
}

// jsToFixed1 renders v with one decimal digit using JavaScript's
// Number.toFixed(1) rounding: exact ties go away from zero, while Go's %.1f
// rounds half-to-even (0.25 would print "0.2" instead of the reference "0.3").
func jsToFixed1(v float64) string {
	return strconv.FormatFloat(math.Round(v*10)/10, 'f', 1, 64)
}

func FormatTokens(n int64) string {
	if n >= 1_000_000 {
		return jsToFixed1(float64(n)/1_000_000) + "M"
	}
	if n >= 1_000 {
		return jsToFixed1(float64(n)/1_000) + "k"
	}
	return strconv.FormatInt(n, 10)
}

func (p *TeammateProgress) RecordToolStart(id, name string, input map[string]any) {
	p.RecordToolUse(name, input)
	p.mu.Lock()
	defer p.mu.Unlock()
	for i := len(p.ActiveTools) - 1; i >= 0; i-- {
		if p.ActiveTools[i].ToolID == id {
			p.ActiveTools = append(p.ActiveTools[:i], p.ActiveTools[i+1:]...)
		}
	}
	p.ActiveTools = append(p.ActiveTools, ActiveTool{ToolID: id, ToolName: name})
}
func (p *TeammateProgress) RecordToolResult(id string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for i, tool := range p.ActiveTools {
		if tool.ToolID == id {
			p.ActiveTools = append(p.ActiveTools[:i], p.ActiveTools[i+1:]...)
			break
		}
	}
}
func (p *TeammateProgress) RecordTurnComplete() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.TurnCount++
	p.ActiveTools = nil
}
func (p *TeammateProgress) ClearActiveTools() { p.mu.Lock(); defer p.mu.Unlock(); p.ActiveTools = nil }

// ClearActivity resets the transient activity trace, mirroring the reference's
// termination cleanup (lastActivity = undefined, recentActivities = []).
func (p *TeammateProgress) ClearActivity() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.LastActivity = nil
	p.RecentActivities = nil
}
func (p *TeammateProgress) SetLastMessage(message string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	// The reference clips by UTF-16 code units (String.length/slice), not runes.
	units := utf16.Encode([]rune(message))
	if len(units) > MaxLastMessageChars {
		message = string(utf16.Decode(units[:MaxLastMessageChars])) + "..."
	}
	p.LastMessage = message
}

type ActiveTool struct{ ToolID, ToolName string }
type AgentProgress struct {
	ToolUseCount, TurnCount int
	TokenCount              int64
	ActiveTools             []ActiveTool
	LastActivity            *ToolActivity
	RecentActivities        []ToolActivity
}
type TeammateUIState struct {
	Name, TeamName, Status, OriginToolCallID string
	StartTime                                int64
	SpinnerVerb, LastMessage                 string
	Progress                                 AgentProgress
}

func (p *TeammateProgress) SetOriginToolCallID(id string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.OriginToolCallID = id
}
func (p *TeammateProgress) Snapshot() TeammateUIState {
	p.mu.Lock()
	defer p.mu.Unlock()
	result := TeammateUIState{Name: p.Name, TeamName: p.TeamName, Status: p.Status, OriginToolCallID: p.OriginToolCallID, StartTime: p.StartTime, SpinnerVerb: p.SpinnerVerb, LastMessage: p.LastMessage,
		Progress: AgentProgress{ToolUseCount: p.ToolUseCount, TurnCount: p.TurnCount, TokenCount: p.TokenCount, ActiveTools: append([]ActiveTool(nil), p.ActiveTools...)}}
	clone := func(a ToolActivity) ToolActivity {
		input := make(map[string]any, len(a.Input))
		for k, v := range a.Input {
			input[k] = v
		}
		a.Input = input
		return a
	}
	if p.LastActivity != nil {
		a := clone(*p.LastActivity)
		result.Progress.LastActivity = &a
	}
	for _, a := range p.RecentActivities {
		result.Progress.RecentActivities = append(result.Progress.RecentActivities, clone(a))
	}
	return result
}
func (tm *TeamManager) GetAllTeammateStates() []TeammateUIState {
	var result []TeammateUIState
	for _, name := range tm.ListTeams() {
		team := tm.GetTeam(name)
		if team == nil {
			continue
		}
		team.mu.Lock()
		var progress []*TeammateProgress
		for _, memberName := range team.memberOrder {
			if member := team.Members[memberName]; member != nil && member.Progress != nil {
				progress = append(progress, member.Progress)
			}
		}
		team.mu.Unlock()
		for _, p := range progress {
			result = append(result, p.Snapshot())
		}
	}
	return result
}
