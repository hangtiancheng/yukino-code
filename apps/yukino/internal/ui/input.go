package ui

import (
	"fmt"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
	"unicode"
	"unicode/utf16"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/yukino-js/yukino/yukino/internal/commands"
	"github.com/yukino-js/yukino/yukino/internal/config"
	"github.com/yukino-js/yukino/yukino/internal/conversation/userbash"
	"github.com/yukino-js/yukino/yukino/internal/images"
	"github.com/yukino-js/yukino/yukino/internal/llm"
	"github.com/yukino-js/yukino/yukino/internal/permissions"
	"github.com/yukino-js/yukino/yukino/internal/plan_file"
	"github.com/yukino-js/yukino/yukino/internal/prompt"
	"github.com/yukino-js/yukino/yukino/internal/utils"
)

var thinkingCompletion = regexp.MustCompile(`^(thinking|think)[ \t]+([a-z]*)$`)
var atCompletion = regexp.MustCompile(`(?:^|\s)@([^\s]*)$`)

func (m *Model) resizeInput() {
	rows := layoutInputRows(m.editor.lines, m.editor.width, m.editor.pastes)
	m.editor.SetHeight(min(len(rows), max(1, max(5, m.height*3/10))))
}

func (m *Model) updateSlashMenu() {
	text := m.editor.Value()
	m.recentCommandCount = 0
	m.slashMatches = nil
	m.slashMenuOpen = false
	if !strings.HasPrefix(text, "/") || len(m.editor.lines) > 1 || m.historyIndex > 0 || m.cmdRegistry == nil {
		return
	}
	query := strings.ToLower(text[1:])
	all := m.cmdRegistry.ListCommands()
	if match := thinkingCompletion.FindStringSubmatch(query); match != nil {
		if cmd := m.cmdRegistry.Find("thinking"); cmd != nil {
			levels := config.ThinkingLevels
			if client, ok := m.client.(llm.ThinkingLevelControl); ok {
				levels = client.GetSupportedThinkingLevels()
			}
			for _, level := range levels {
				if strings.HasPrefix(level, match[2]) {
					copy := *cmd
					copy.Name = match[1] + " " + level
					copy.Description = "Set thinking to " + level
					m.slashMatches = append(m.slashMatches, &copy)
				}
			}
		}
	} else if strings.IndexFunc(query, unicode.IsSpace) >= 0 {
		return
	} else if query == "" {
		recent, _ := (commands.CommandUsageTracker{}).GetRecentlyUsed(5)
		used := map[string]bool{}
		for _, name := range recent {
			used[name] = true
		}
		for _, cmd := range all {
			if used[cmd.Name] {
				m.slashMatches = append(m.slashMatches, cmd)
				m.recentCommandCount++
			}
		}
		for _, cmd := range all {
			if !used[cmd.Name] {
				m.slashMatches = append(m.slashMatches, cmd)
			}
		}
	} else {
		seen := map[string]bool{}
		add := func(cmd *commands.Command) {
			if !seen[cmd.Name] {
				seen[cmd.Name] = true
				m.slashMatches = append(m.slashMatches, cmd)
			}
		}
		for _, cmd := range all {
			if strings.ToLower(cmd.Name) == query {
				add(cmd)
			}
		}
		for _, cmd := range all {
			if strings.HasPrefix(strings.ToLower(cmd.Name), query) {
				add(cmd)
			}
		}
		fuse := NewFuse(all, []fuseKey[*commands.Command]{
			{weight: 3, get: func(c *commands.Command) (string, bool) { return c.Name, true }},
			// The reference keeps a weight-2 "aliases" key although Command has
			// no aliases field; it never matches but still shifts Fuse's weight
			// normalization, so it is retained for identical fuzzy scores.
			{weight: 2, get: func(c *commands.Command) (string, bool) { return "", false }},
			{weight: 0.5, get: func(c *commands.Command) (string, bool) { return c.Description, true }},
		}, 0.4, false)
		for _, cmd := range fuse.Search(query) {
			add(cmd)
		}
	}
	if m.slashCursor >= len(m.slashMatches) {
		m.slashCursor = 0
	}
	m.slashMenuOpen = len(m.slashMatches) > 0 && !m.dropdownDismissed
}

func (m *Model) updateAtMenu() {
	m.atMenuOpen = false
	m.atMatches = nil
	if strings.HasPrefix(m.editor.Value(), "/") || isUserBash(m.editor.Value()) || m.dropdownDismissed {
		return
	}
	line := []rune(m.editor.lines[m.editor.line])
	before := string(line[:min(m.editor.col, len(line))])
	match := atCompletion.FindStringSubmatch(before)
	if match == nil {
		m.atCursor = 0
		return
	}
	cwd := m.getWorkDir()
	if m.fileCacheCwd != cwd || m.fileCacheVersion != m.fileFactsVersion || time.Since(m.fileCacheTime) >= FileCacheTTLMs*time.Millisecond {
		m.fileCache = utils.ScanCwdFiles(cwd, 0)
		m.fileCacheCwd = cwd
		m.fileCacheVersion = m.fileFactsVersion
		m.fileCacheTime = time.Now()
	}
	m.atPrefix = match[1]
	m.atMatches = utils.FilterFileMatches(m.fileCache, m.atPrefix, 8)
	if m.atCursor >= len(m.atMatches) {
		m.atCursor = 0
	}
	m.atMenuOpen = len(m.atMatches) > 0
}

func (m *Model) historyUp() {
	if len(m.historyEntries) == 0 {
		return
	}
	if m.historyIndex == 0 {
		snapshot := m.editor.snapshot()
		m.historyDraft = &snapshot
	}
	m.historyIndex = min(m.historyIndex+1, len(m.historyEntries))
	m.editor.SetValue(m.historyEntries[len(m.historyEntries)-m.historyIndex])
	m.editor.pastes = nil
	m.editor.line = 0
	m.editor.col = len([]rune(m.editor.lines[0]))
	m.dropdownDismissed = true
	m.resizeInput()
}

func (m *Model) historyDown() {
	if m.historyIndex <= 0 {
		return
	}
	m.historyIndex--
	if m.historyIndex == 0 {
		if m.historyDraft != nil {
			m.editor.restore(*m.historyDraft)
		} else {
			m.editor.Reset()
		}
		m.historyDraft = nil
	} else {
		m.editor.SetValue(m.historyEntries[len(m.historyEntries)-m.historyIndex])
		m.editor.pastes = nil
		m.editor.line = 0
		m.editor.col = len([]rune(m.editor.lines[0]))
	}
	m.resizeInput()
}

func (m *Model) completeFile(path string) {
	line := []rune(m.editor.lines[m.editor.line])
	before := string(line[:m.editor.col])
	after := string(line[m.editor.col:])
	before = regexp.MustCompile(`@[^\s]*$`).ReplaceAllStringFunc(before, func(string) string { return "@" + path })
	after = strings.TrimLeftFunc(after, func(r rune) bool { return !unicode.IsSpace(r) })
	separator := " "
	if strings.HasPrefix(after, " ") {
		separator = ""
	}
	m.editor.lines[m.editor.line] = before + separator + after
	m.editor.col = len([]rune(before)) + 1
	m.atCursor = 0
	m.resizeInput()
	m.updateAtMenu()
}

func (m *Model) completeCommand() {
	if m.slashCursor >= len(m.slashMatches) {
		return
	}
	m.editor.SetValue("/" + m.slashMatches[m.slashCursor].Name + " ")
	m.slashCursor = 0
	m.resizeInput()
	m.updateSlashMenu()
	m.updateAtMenu()
}

type clipboardImageMsg struct {
	generation int
	result     images.SaveClipboardImageResult
	cwd        string
}

func (m *Model) pasteImage() tea.Cmd {
	if m.pastingImage {
		return nil
	}
	m.pastingImage = true
	m.pasteError = ""
	m.pasteGeneration++
	generation, sessionID, cwd := m.pasteGeneration, m.sessionID, m.getWorkDir()
	return func() tea.Msg { return clipboardImageMsg{generation, images.SaveClipboardImage(sessionID), cwd} }
}
func (m *Model) clearDraft() {
	m.editor.Reset()
	m.historyIndex = 0
	m.historyDraft = nil
	m.pasteGeneration++
	m.pastingImage = false
	m.pasteError = ""
	m.dropdownDismissed = false
	m.slashMenuOpen = false
	m.slashMatches = nil
	m.slashCursor = 0
	m.atMenuOpen = false
	m.atMatches = nil
	m.atCursor = 0
}
func (m *Model) handleClipboard(msg clipboardImageMsg) {
	if msg.generation != m.pasteGeneration {
		return
	}
	m.pastingImage = false
	if msg.result.OK {
		path, err := filepath.Rel(msg.cwd, msg.result.Value)
		if err != nil {
			path = msg.result.Value
		}
		m.editor.paste("'@"+path+"'", true)
		m.dropdownDismissed = true
		m.resizeInput()
	} else {
		m.pasteError = msg.result.Reason
	}
}

func (m Model) handleComposerKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if m.providerSwitching {
		return m, nil
	}
	key := msg.String()
	_, _, dockRows := m.terminalBudgets()
	completionsVisible := m.completionRows(dockRows) > 0
	showAt, showSlash := m.atMenuOpen && completionsVisible, m.slashMenuOpen && completionsVisible
	if key != "up" && key != "down" {
		m.editor.preferredColumn = -1
	}
	if key == "esc" {
		if showAt || showSlash {
			m.atMenuOpen = false
			m.slashMenuOpen = false
			m.atMatches = nil
			m.slashMatches = nil
			m.dropdownDismissed = true
			return m, nil
		}
		if m.foregroundBusy() {
			m.interruptUserWork()
		}
		return m, nil
	}
	if key == "ctrl+b" {
		return m, m.backgroundShells()
	}
	if key == "shift+tab" {
		if m.ag != nil && m.ag.Checker != nil {
			checker := m.ag.Checker
			mode := nextPermissionMode(checker.Mode())
			if checker.Mode() == permissions.ModePlan {
				path := checker.CurrentPlanPath()
				m.conversation.AddSystemReminder(prompt.BuildPlanModeExitReminder(path, path != "" && plan_file.PlanExists(checker)))
				checker.ExitPlanMode(mode)
			} else {
				checker.SetMode(mode)
			}
		}
		return m, nil
	}
	if runtime.GOOS != "windows" && key == "ctrl+v" || runtime.GOOS == "windows" && msg.Alt && string(msg.Runes) == "v" {
		cmd := m.pasteImage()
		return m, cmd
	}
	if msg.Paste || msg.Type == tea.KeyRunes && (strings.ContainsAny(string(msg.Runes), "\r\n") || len(utf16.Encode(msg.Runes)) > 1000) {
		if len(msg.Runes) > 0 {
			m.editor.paste(string(msg.Runes), false)
			m.dropdownDismissed = true
			m.slashMenuOpen = false
			m.atMenuOpen = false
			m.resizeInput()
			return m, nil
		}
		cmd := m.pasteImage()
		return m, cmd
	}
	if key == "ctrl+j" || key == "shift+enter" {
		m.editor.InsertString("\n")
		m.resizeInput()
		m.updateSlashMenu()
		m.updateAtMenu()
		return m, nil
	}
	// The reference submits on any return keypress that is not a newline
	// request, including alt/option+enter.
	if key == "enter" || key == "alt+enter" {
		if showAt && m.atCursor < len(m.atMatches) {
			m.completeFile(m.atMatches[m.atCursor])
			return m, nil
		}
		bareThinking := regexp.MustCompile(`(?i)^/(thinking|think)\s*$`).MatchString(m.editor.Value())
		if showSlash && !bareThinking && m.slashCursor < len(m.slashMatches) {
			m.completeCommand()
			return m, nil
		}
		text := strings.TrimSpace(expandPastes(m.editor.Value(), m.editor.pastes))
		if text == "" || m.pastingImage {
			return m, nil
		}
		return m.submitInput(text)
	}
	if key == "tab" {
		if showAt && m.atCursor < len(m.atMatches) {
			m.completeFile(m.atMatches[m.atCursor])
		} else if strings.HasPrefix(m.editor.Value(), "/") && len(m.slashMatches) > 0 {
			m.completeCommand()
		}
		return m, nil
	}
	if key == "up" || key == "down" {
		direction := 1
		if key == "up" {
			direction = -1
		}
		if showAt {
			m.editor.preferredColumn = -1
			m.atCursor = (m.atCursor + direction + len(m.atMatches)) % len(m.atMatches)
			return m, nil
		}
		if showSlash {
			m.editor.preferredColumn = -1
			m.slashCursor = (m.slashCursor + direction + len(m.slashMatches)) % len(m.slashMatches)
			return m, nil
		}
		if m.editor.moveVertical(direction) {
			m.resizeInput()
			return m, nil
		}
		if direction < 0 {
			if m.editor.Value() == "" && m.historyIndex == 0 {
				if text, ok := m.recallQueued(); ok {
					m.editor.SetValue(text)
					m.editor.pastes = nil
					m.historyDraft = nil
					m.pasteGeneration++
					m.pastingImage = false
					m.pasteError = ""
					m.atCursor = 0
					m.slashCursor = 0
					m.dropdownDismissed = true
					m.resizeInput()
					return m, nil
				}
			}
			if len(m.editor.lines) == 1 || m.historyIndex > 0 {
				m.historyUp()
			}
		} else if m.historyIndex > 0 {
			m.historyDown()
		} else if len(m.agentEntries()) > 0 {
			return m.openAgentsDialog()
		}
		return m, nil
	}
	line := []rune(m.editor.lines[m.editor.line])
	col := m.editor.col
	switch key {
	case "home", "ctrl+a":
		m.editor.col = 0
	case "end", "ctrl+e":
		m.editor.col = len(line)
	case "left":
		if col > 0 {
			m.editor.col = inputBoundary(string(line), col, "previous", m.editor.pastes)
		} else if m.editor.line > 0 {
			m.editor.line--
			m.editor.col = len([]rune(m.editor.lines[m.editor.line]))
		}
	case "right":
		if col < len(line) {
			m.editor.col = inputBoundary(string(line), col, "next", m.editor.pastes)
		} else if m.editor.line < len(m.editor.lines)-1 {
			m.editor.line++
			m.editor.col = 0
		}
	case "backspace", "delete":
		if key == "delete" && col < len(line) {
			next := inputBoundary(string(line), col, "next", m.editor.pastes)
			m.editor.lines[m.editor.line] = string(line[:col]) + string(line[next:])
		} else if key == "backspace" && col > 0 {
			previous := inputBoundary(string(line), col, "previous", m.editor.pastes)
			m.editor.lines[m.editor.line] = string(line[:previous]) + string(line[col:])
			m.editor.col = previous
		} else if key == "backspace" && m.editor.line > 0 {
			previous := len([]rune(m.editor.lines[m.editor.line-1]))
			m.editor.lines[m.editor.line-1] += string(line)
			m.editor.lines = append(m.editor.lines[:m.editor.line], m.editor.lines[m.editor.line+1:]...)
			m.editor.line--
			m.editor.col = previous
		} else if key == "delete" && m.editor.line < len(m.editor.lines)-1 {
			m.editor.lines[m.editor.line] += m.editor.lines[m.editor.line+1]
			m.editor.lines = append(m.editor.lines[:m.editor.line+1], m.editor.lines[m.editor.line+2:]...)
		}
		m.slashCursor = 0
		m.atCursor = 0
	default:
		if text, ok := textForKey(msg); ok {
			m.editor.InsertString(text)
			m.dropdownDismissed = false
			m.slashCursor = 0
			m.atCursor = 0
		}
	}
	m.resizeInput()
	m.updateSlashMenu()
	m.updateAtMenu()
	return m, nil
}

func (m Model) renderSlashMenu(rows int) string {
	count := min(8, max(0, rows))
	start := getListWindowStart(len(m.slashMatches), m.slashCursor, count)
	title := "COMMANDS"
	if m.recentCommandCount > 0 && start == 0 {
		title = "RECENTLY USED"
	}
	if len(m.slashMatches) > count {
		title += fmt.Sprintf(" (%d/%d)", m.slashCursor+1, len(m.slashMatches))
	}
	lines := []string{lipgloss.NewStyle().Foreground(dimText).Render(truncateToWidth(title, m.width, "…"))}
	padding := boolColumn(m.width > 2)
	width := max(1, m.width-padding*2)
	for i := start; i < min(len(m.slashMatches), start+count); i++ {
		cmd := m.slashMatches[i]
		pointer := " "
		style := lipgloss.NewStyle().Foreground(mutedText)
		if i == m.slashCursor {
			pointer = Icons.Arrow
			style = style.Foreground(accentColor).Background(lipgloss.Color(Theme.SelectedBg))
		}
		label := truncateToWidth(pointer+" /"+cmd.Name, width, "…")
		desc := strings.Join(strings.Fields(cmd.Description), " ")
		tag := ""
		for _, candidate := range CommandTags {
			if strings.HasSuffix(desc, candidate) {
				tag = candidate
				desc = strings.TrimSpace(strings.TrimSuffix(desc, candidate))
				break
			}
		}
		descWidth := width - visibleWidth(label) - 1
		if tag != "" {
			descWidth -= visibleWidth(tag) + 1
		}
		if m.width >= 60 && descWidth >= 10 {
			label += " " + truncateToWidth(desc, descWidth, "…")
			if tag != "" {
				label += " " + tag
			}
		}
		lines = append(lines, style.Width(m.width).Render(strings.Repeat(" ", padding)+label))
	}
	return strings.Join(lines, "\n")
}
func (m Model) renderAtMenu(rows int) string {
	count := min(8, max(0, rows))
	start := getListWindowStart(len(m.atMatches), m.atCursor, count)
	lines := []string{lipgloss.NewStyle().Foreground(dimText).Render(truncateToWidth("FILES", m.width, "…"))}
	padding := boolColumn(m.width > 2)
	width := max(1, m.width-padding*2)
	for i := start; i < min(len(m.atMatches), start+count); i++ {
		pointer := " "
		style := lipgloss.NewStyle().Foreground(mutedText)
		if i == m.atCursor {
			pointer = Icons.Arrow
			style = style.Foreground(accentColor).Background(lipgloss.Color(Theme.SelectedBg))
		}
		lines = append(lines, style.Width(m.width).Render(strings.Repeat(" ", padding)+truncateToWidth(pointer+" @"+m.atMatches[i], width, "…")))
	}
	return strings.Join(lines, "\n")
}

func isUserBash(text string) bool { _, _, ok := userbash.ParseCommand(text); return ok }
