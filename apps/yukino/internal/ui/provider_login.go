package ui

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/yukino-js/yukino/yukino/internal/config"
	"github.com/yukino-js/yukino/yukino/internal/llm"
	"github.com/yukino-js/yukino/yukino/internal/mcp"
)

// Port of src/ui/provider-login.tsx.

var loginFieldKeys = []string{"name", "protocol", "base_url", "api_key", "model", "thinking", "context_window", "max_output_tokens"}
var loginMouseReport = regexp.MustCompile(`\[<\d+;\d+;\d+[Mm]`)

var loginFieldLabels = map[string]string{
	"name":              "Name",
	"protocol":          "Protocol",
	"base_url":          "Base URL",
	"api_key":           "API key",
	"model":             "Model",
	"thinking":          "Thinking",
	"context_window":    "Context window",
	"max_output_tokens": "Max output tokens",
}

type providerLoginForm struct {
	name            string
	protocol        string
	baseURL         string
	apiKey          string
	model           string
	thinking        string
	contextWindow   string
	maxOutputTokens string
}

func newProviderLoginForm(initial *config.ProviderConfig) providerLoginForm {
	form := providerLoginForm{
		protocol:        "anthropic",
		thinking:        config.DefaultThinkingLevel,
		contextWindow:   strconv.Itoa(config.DefaultContextWindow),
		maxOutputTokens: strconv.Itoa(config.DefaultMaxOutputTokens),
	}
	if initial != nil {
		form.name = initial.Name
		if initial.Protocol != "" {
			form.protocol = initial.Protocol
		}
		form.baseURL = initial.BaseURL
		form.apiKey = initial.APIKey
		form.model = initial.Model
		if initial.Thinking != "" {
			form.thinking = initial.Thinking
		}
		if initial.ContextWindow > 0 {
			form.contextWindow = strconv.Itoa(int(initial.ContextWindow))
		}
		if initial.MaxOutputTokens > 0 {
			form.maxOutputTokens = strconv.Itoa(int(initial.MaxOutputTokens))
		}
	}
	return form
}

func (f *providerLoginForm) field(field string) *string {
	switch field {
	case "name":
		return &f.name
	case "protocol":
		return &f.protocol
	case "base_url":
		return &f.baseURL
	case "api_key":
		return &f.apiKey
	case "model":
		return &f.model
	case "thinking":
		return &f.thinking
	case "context_window":
		return &f.contextWindow
	case "max_output_tokens":
		return &f.maxOutputTokens
	}
	return nil
}

func (f *providerLoginForm) value(field string) string {
	if target := f.field(field); target != nil {
		return *target
	}
	return ""
}

func (f *providerLoginForm) toInput() map[string]any {
	input := map[string]any{
		"name":              f.name,
		"protocol":          f.protocol,
		"base_url":          f.baseURL,
		"api_key":           f.apiKey,
		"model":             f.model,
		"thinking":          f.thinking,
		"context_window":    f.contextWindow,
		"max_output_tokens": f.maxOutputTokens,
	}
	return input
}

func (m Model) loginInput() map[string]any {
	input := m.loginForm.toInput()
	if initial := m.loginInitial; initial != nil {
		if initial.Reasoning != nil {
			input["reasoning"] = *initial.Reasoning
		}
		if initial.ThinkingMode != "" {
			input["thinking_mode"] = initial.ThinkingMode
		}
		if initial.ThinkingLevelMap != nil {
			levels := map[string]any{}
			for level, override := range initial.ThinkingLevelMap {
				if override.Null {
					levels[level] = nil
				} else {
					levels[level] = override.Effort
				}
			}
			input["thinking_level_map"] = levels
		}
		for _, extra := range initial.Extra {
			if _, exists := input[extra.Key]; !exists {
				input[extra.Key] = extra.Value
			}
		}
	}
	return input
}

type loginConnection struct {
	protocol string
	baseURL  string
	apiKey   string
}

type loginDiscoveryState struct {
	status string // idle | loading | ready | empty | error
	models []llm.DiscoveredModel
}

type loginDiscoveryTickMsg struct{ gen int }

type loginDiscoveryDoneMsg struct {
	gen    int
	models []llm.DiscoveredModel
	err    error
}

func (m Model) loginEditingConnection() bool {
	field := loginFieldKeys[m.loginCursor]
	return field == "base_url" || field == "api_key"
}

// loginProvider mirrors thinkingProvider in the reference: the form overlaid
// on the initial values.
func (m Model) loginProvider() config.ProviderConfig {
	p := config.ProviderConfig{}
	if m.loginInitial != nil {
		p = *m.loginInitial
	}
	p.Name = m.loginForm.name
	p.Protocol = m.loginForm.protocol
	p.BaseURL = m.loginForm.baseURL
	p.APIKey = m.loginForm.apiKey
	p.Model = m.loginForm.model
	p.Thinking = m.loginForm.thinking
	if cw, err := strconv.Atoi(strings.TrimSpace(m.loginForm.contextWindow)); err == nil {
		p.ContextWindow = float64(cw)
	}
	if mot, err := strconv.Atoi(strings.TrimSpace(m.loginForm.maxOutputTokens)); err == nil {
		p.MaxOutputTokens = float64(mot)
	}
	return p
}

// loginRefreshDiscovery mirrors the discovery effect: a completed connection
// is not refetched, editing the connection resets the state, and a valid URL
// triggers a debounced fetch.
func (m *Model) loginRefreshDiscovery() tea.Cmd {
	conn := loginConnection{
		protocol: m.loginForm.protocol,
		baseURL:  m.loginForm.baseURL,
		apiKey:   m.loginForm.apiKey,
	}
	if m.loginCompletedConn != nil && *m.loginCompletedConn == conn {
		return nil
	}
	m.loginDiscoveryGen++
	if m.loginDiscoveryCancel != nil {
		m.loginDiscoveryCancel()
		m.loginDiscoveryCancel = nil
	}
	m.loginCompletedConn = nil
	m.loginDiscovery = loginDiscoveryState{status: "idle"}
	if m.loginEditingConnection() || llm.ModelListURL(conn.protocol, conn.baseURL) == "" {
		return nil
	}
	gen := m.loginDiscoveryGen
	return tea.Tick(400*time.Millisecond, func(time.Time) tea.Msg {
		return loginDiscoveryTickMsg{gen: gen}
	})
}

func (m Model) startLoginDiscovery(ctx context.Context, gen int) tea.Cmd {
	cfg := llm.DiscoveryConfig{
		Protocol: m.loginForm.protocol,
		BaseURL:  m.loginForm.baseURL,
		APIKey:   m.loginForm.apiKey,
	}
	return func() tea.Msg {
		models, err := llm.DiscoverModels(ctx, cfg)
		return loginDiscoveryDoneMsg{gen: gen, models: models, err: err}
	}
}

func (m *Model) handleLoginDiscoveryTick(msg loginDiscoveryTickMsg) (tea.Model, tea.Cmd) {
	if msg.gen != m.loginDiscoveryGen {
		return m, nil
	}
	m.loginDiscovery = loginDiscoveryState{status: "loading"}
	ctx, cancel := context.WithCancel(m.lifeCtx)
	m.loginDiscoveryCancel = cancel
	return m, m.startLoginDiscovery(ctx, msg.gen)
}

func (m *Model) handleLoginDiscoveryDone(msg loginDiscoveryDoneMsg) (tea.Model, tea.Cmd) {
	if msg.gen != m.loginDiscoveryGen {
		return m, nil
	}
	m.loginCompletedConn = &loginConnection{
		protocol: m.loginForm.protocol,
		baseURL:  m.loginForm.baseURL,
		apiKey:   m.loginForm.apiKey,
	}
	if msg.err != nil {
		m.loginDiscovery = loginDiscoveryState{status: "error"}
		return m, nil
	}
	status := "empty"
	if len(msg.models) > 0 {
		status = "ready"
	}
	m.loginDiscovery = loginDiscoveryState{status: status, models: msg.models}
	if first := msg.models; len(first) > 0 && m.loginForm.model == "" && !m.loginModelEdited && !m.loginSubmitting {
		m.loginForm.model = first[0].ID
		delete(m.loginFieldErrors, "model")
		if loginFieldKeys[m.loginCursor] == "model" {
			m.loginFieldCursor = len([]rune(first[0].ID))
		}
	}
	return m, nil
}

func (m Model) openLoginDialog() (tea.Model, tea.Cmd) {
	m.loginDialog = true
	m.loginInitial = nil
	if m.selectedProvider != nil {
		initial := *m.selectedProvider
		if control, ok := m.client.(llm.ThinkingLevelControl); ok {
			initial.Thinking = control.GetThinkingLevel()
		}
		m.loginInitial = &initial
	}
	m.loginForm = newProviderLoginForm(m.loginInitial)
	m.loginCursor = 0
	m.loginFieldCursor = 0
	m.loginFieldErrors = map[string]string{}
	m.loginFormError = ""
	m.loginSubmitting = false
	m.loginModelEdited = false
	m.loginCompletedConn = nil
	m.loginDiscovery = loginDiscoveryState{status: "idle"}
	m.loginDiscoveryGen++
	return m, m.loginRefreshDiscovery()
}

func (m Model) closeLoginDialog() (tea.Model, tea.Cmd) {
	m.loginDialog = false
	m.loginDiscoveryGen++
	if m.loginDiscoveryCancel != nil {
		m.loginDiscoveryCancel()
		m.loginDiscoveryCancel = nil
	}
	return m, nil
}

// loginUpdateText mirrors updateText: replaces the active field's value and
// resets its validation error.
func (m *Model) loginUpdateText(value string, nextCursor int) tea.Cmd {
	field := loginFieldKeys[m.loginCursor]
	if field == "protocol" || field == "thinking" {
		return nil
	}
	var cmd tea.Cmd
	previous := m.loginForm.value(field)
	if target := m.loginForm.field(field); target != nil {
		*target = value
	}
	m.loginFieldCursor = nextCursor
	delete(m.loginFieldErrors, field)
	m.loginFormError = ""
	if field == "model" {
		m.loginModelEdited = true
	}
	if (field == "base_url" || field == "api_key") && previous != value {
		cmd = m.loginRefreshDiscovery()
	}
	return cmd
}

func (m *Model) loginInsertText(text string) tea.Cmd {
	if text == "" || m.loginSubmitting {
		return nil
	}
	field := loginFieldKeys[m.loginCursor]
	if field == "protocol" || field == "thinking" {
		return nil
	}
	value := m.loginForm.value(field)
	runes := []rune(value)
	position := min(m.loginFieldCursor, len(runes))
	inserted := []rune(strings.ReplaceAll(strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\r", "\n"), "\n", ""))
	updated := append(append(append([]rune{}, runes[:position]...), inserted...), runes[position:]...)
	return m.loginUpdateText(string(updated), position+len(inserted))
}

func (m *Model) loginMoveField(delta int) tea.Cmd {
	wasEditing := m.loginEditingConnection()
	next := (m.loginCursor + delta + len(loginFieldKeys)) % len(loginFieldKeys)
	m.loginCursor = next
	field := loginFieldKeys[next]
	if field == "protocol" || field == "thinking" {
		m.loginFieldCursor = 0
	} else {
		m.loginFieldCursor = len([]rune(m.loginForm.value(field)))
	}
	if wasEditing != m.loginEditingConnection() {
		return m.loginRefreshDiscovery()
	}
	return nil
}

func (m Model) submitLogin() (tea.Model, tea.Cmd) {
	if m.loginSubmitting {
		return m, nil
	}
	input := m.loginInput()
	provider, err := config.ParseProviderLogin(input)
	if err != nil {
		if validation, ok := err.(*config.LoginValidationError); ok {
			m.loginFieldErrors = validation.Fields
			m.loginFormError = validation.Form
		} else {
			m.loginFieldErrors = map[string]string{}
			m.loginFormError = err.Error()
		}
		return m, nil
	}
	m.loginFieldErrors = map[string]string{}
	m.loginFormError = ""

	// Construct the client before saving so invalid configuration leaves the
	// form editable.
	wd := m.getWorkDir()
	client, err := llm.NewClient(&provider, providerSystemPrompt(&provider, wd))
	if err != nil {
		m.loginFormError = err.Error()
		return m, nil
	}
	result, err := config.SaveProvider(input, m.providers)
	if err != nil {
		m.loginFormError = err.Error()
		return m, nil
	}
	m.providers = append(m.providers[:0], result.Providers...)
	m.loginDialog = false
	m.loginDiscoveryGen++
	if m.loginDiscoveryCancel != nil {
		m.loginDiscoveryCancel()
		m.loginDiscoveryCancel = nil
	}

	selected := &m.providers[0]
	selectedIdx := 0
	for i := range m.providers {
		if m.providers[i].BaseURL == result.Provider.BaseURL {
			selected = &m.providers[i]
			selectedIdx = i
			break
		}
	}
	_ = config.PersistDefaultProvider(selectedIdx)
	m.selectedProvider = selected

	if m.state == stateProviderSelect || m.client == nil {
		m.loginInitial = nil
		return m, m.activateInitialProvider(selected)
	}

	m.stopMemoryTasks()
	m.bindClient(client, selected)
	m.activityError = ""
	mcp.DecideAndApply(m.registry, selected.BaseURL, selected.Protocol, config.GetContextWindow(selected), m.MCPLoading)
	verb := "Saved to"
	if result.Replaced {
		verb = "Updated"
	}
	m.chatMessages = append(m.chatMessages, chatMessage{
		role:    "system",
		content: fmt.Sprintf("Provider %s activated. %s ~/.yukino/config.yaml.", result.Provider.Name, verb),
	})
	return m, nil
}

func (m Model) handleLoginDialog(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if m.loginSubmitting {
		return m, nil
	}
	if msg.Paste && len(msg.Runes) > 0 {
		cmd := m.loginInsertText(string(msg.Runes))
		return m, cmd
	}
	field := loginFieldKeys[m.loginCursor]
	value := m.loginForm.value(field)
	runes := []rune(value)
	position := min(m.loginFieldCursor, len(runes))

	switch msg.String() {
	case "esc":
		return m.closeLoginDialog()
	case "tab":
		cmd := m.loginMoveField(1)
		return m, cmd
	case "shift+tab":
		cmd := m.loginMoveField(-1)
		return m, cmd
	case "up":
		cmd := m.loginMoveField(-1)
		return m, cmd
	case "down":
		cmd := m.loginMoveField(1)
		return m, cmd
	case "enter":
		return m.submitLogin()
	}

	switch field {
	case "protocol":
		if msg.String() == "left" || msg.String() == "right" {
			idx := 0
			for i, p := range Protocols {
				if p == m.loginForm.protocol {
					idx = i
				}
			}
			if msg.String() == "right" {
				idx = (idx + 1) % len(Protocols)
			} else {
				idx = (idx - 1 + len(Protocols)) % len(Protocols)
			}
			m.loginForm.protocol = Protocols[idx]
			delete(m.loginFieldErrors, "protocol")
			m.loginFormError = ""
			cmd := m.loginRefreshDiscovery()
			return m, cmd
		}
		return m, nil
	case "thinking":
		if msg.String() == "left" || msg.String() == "right" {
			provider := m.loginProvider()
			levels := config.GetSupportedThinkingLevels(&provider)
			current := config.GetThinkingLevel(&provider)
			idx := 0
			for i, level := range levels {
				if level == current {
					idx = i
				}
			}
			if msg.String() == "right" {
				idx = (idx + 1) % len(levels)
			} else {
				idx = (idx - 1 + len(levels)) % len(levels)
			}
			m.loginForm.thinking = levels[idx]
			delete(m.loginFieldErrors, "thinking")
			m.loginFormError = ""
		}
		return m, nil
	}

	switch msg.String() {
	case "left", "right":
		if field == "model" && len(m.loginDiscovery.models) > 0 {
			idx := -1
			for i, model := range m.loginDiscovery.models {
				if model.ID == value {
					idx = i
				}
			}
			next := 0
			if idx < 0 {
				if msg.String() == "left" {
					next = len(m.loginDiscovery.models) - 1
				}
			} else {
				if msg.String() == "right" {
					next = (idx + 1) % len(m.loginDiscovery.models)
				} else {
					next = (idx - 1 + len(m.loginDiscovery.models)) % len(m.loginDiscovery.models)
				}
			}
			cmd := m.loginUpdateText(m.loginDiscovery.models[next].ID, len([]rune(m.loginDiscovery.models[next].ID)))
			return m, cmd
		}
		bounds := graphemeBounds(value)
		if msg.String() == "left" {
			m.loginFieldCursor = previousGraphemeBoundary(bounds, position)
		} else {
			m.loginFieldCursor = nextGraphemeBoundary(bounds, position)
		}
		return m, nil
	case "ctrl+u":
		cmd := m.loginUpdateText("", 0)
		return m, cmd
	case "home", "ctrl+a":
		m.loginFieldCursor = 0
		return m, nil
	case "end", "ctrl+e":
		m.loginFieldCursor = len(runes)
		return m, nil
	case "ctrl+b":
		bounds := graphemeBounds(value)
		m.loginFieldCursor = previousGraphemeBoundary(bounds, position)
		return m, nil
	case "ctrl+f":
		bounds := graphemeBounds(value)
		m.loginFieldCursor = nextGraphemeBoundary(bounds, position)
		return m, nil
	case "backspace":
		if position > 0 {
			bounds := graphemeBounds(value)
			previous := previousGraphemeBoundary(bounds, position)
			cmd := m.loginUpdateText(string(runes[:previous])+string(runes[position:]), previous)
			return m, cmd
		}
		return m, nil
	case "delete":
		if position < len(runes) {
			bounds := graphemeBounds(value)
			next := nextGraphemeBoundary(bounds, position)
			cmd := m.loginUpdateText(string(runes[:position])+string(runes[next:]), position)
			return m, cmd
		}
		return m, nil
	default:
		if text, ok := textForKey(msg); ok {
			if strings.Contains(text, "\x1b") || loginMouseReport.MatchString(text) {
				return m, nil
			}
			cmd := m.loginInsertText(text)
			return m, cmd
		}
		return m, nil
	}
}

// loginDisplayValue mirrors displayValue in the reference.
func (m Model) loginDisplayValue(field string) string {
	switch field {
	case "protocol":
		return m.loginForm.protocol
	case "thinking":
		provider := m.loginProvider()
		return config.GetThinkingLevel(&provider)
	case "api_key":
		if m.loginForm.apiKey != "" {
			return strings.Repeat("•", len([]rune(m.loginForm.apiKey)))
		}
		return ""
	}
	return m.loginForm.value(field)
}

// renderLoginFrame renders the login form inside a SelectorFrame with the
// given row budget; the startup state passes the full terminal height.
func (m Model) renderLoginFrame(rows int) string {
	// Reference: max(1, columns || 80).
	columns := m.width
	if columns == 0 {
		columns = 80
	}
	frameWidth := max(1, columns)
	framePadding := 0
	if frameWidth > 2 {
		framePadding = 2
	}
	contentWidth := max(1, frameWidth-framePadding)
	labelWidth := max(1, min(24, int(float64(contentWidth)*0.36)))
	valueWidth := max(1, contentWidth-labelWidth)
	if contentWidth > labelWidth {
		valueWidth = max(1, contentWidth-labelWidth-1)
	}

	subtitle := "Add a provider connection"
	if m.loginSubmitting {
		subtitle = "Saving provider…"
	} else if m.loginFormError != "" {
		subtitle = m.loginFormError
	}

	var content strings.Builder
	focusRow := 0
	selectedBg := lipgloss.Color(Theme.SelectedBg)
	for _, field := range loginFieldKeys {
		selected := loginFieldKeys[m.loginCursor] == field
		if selected {
			focusRow = strings.Count(content.String(), "\n")
		}
		rawValue := m.loginDisplayValue(field)

		var valueCell string
		switch {
		case selected && (field == "protocol" || field == "thinking"):
			valueCell = lipgloss.NewStyle().Foreground(normalText).Render("‹ " + rawValue + " ›")
		case selected:
			window := cursorWindow(rawValue, m.loginFieldCursor, valueWidth)
			before := ""
			if window.leadingEllipsis {
				before = "…"
			}
			after := window.after
			if window.trailingEllipsis {
				after += "…"
			}
			style := lipgloss.NewStyle().Foreground(normalText)
			valueCell = style.Render(before+window.before) +
				cursorMarker + style.Render(window.current) +
				style.Render(after)
		default:
			display := rawValue
			if display == "" {
				display = "(empty)"
			}
			valueCell = lipgloss.NewStyle().Foreground(mutedText).Render(truncateToWidth(display, valueWidth, "…"))
		}

		label := loginFieldLabels[field] + ":"
		if selected {
			label = "› " + label
		} else {
			label = " " + label
		}
		labelStyle := lipgloss.NewStyle().Foreground(mutedText)
		if selected {
			labelStyle = lipgloss.NewStyle().Foreground(accentColor)
		}
		label = truncateToWidth(label, labelWidth, "…")
		row := labelStyle.Render(label+strings.Repeat(" ", max(0, labelWidth-visibleWidth(label)))) + valueCell
		if selected {
			row = lipgloss.NewStyle().Background(selectedBg).Width(contentWidth).Render(row)
		}
		content.WriteString(row)
		content.WriteString("\n")
		if errMsg := m.loginFieldErrors[field]; errMsg != "" {
			content.WriteString(lipgloss.NewStyle().Foreground(redText).Render(truncateToWidth("  "+errMsg, contentWidth, "…")))
			content.WriteString("\n")
		}
	}

	var help string
	switch m.loginDiscovery.status {
	case "loading":
		help = "Fetching models…"
	case "ready":
		help = fmt.Sprintf("%d models available · ←→ cycle", len(m.loginDiscovery.models))
	case "empty":
		help = "No models returned"
	case "error":
		help = "Model discovery unavailable"
	default:
		if m.loginEditingConnection() {
			help = "Tab to finish connection and fetch models"
		} else {
			help = "Models: waiting for a valid URL"
		}
	}
	content.WriteString(lipgloss.NewStyle().Foreground(mutedText).Render(help))
	content.WriteString("\n")
	content.WriteString(selectorHintStyle().Render("type/paste any ID · Ctrl+U clear"))
	content.WriteString("\n")
	content.WriteString(selectorHintStyle().Render("Home/End · Ctrl+B/F move cursor"))

	return m.renderSelectorFrame(selectorFrameParams{
		title:    "Provider login",
		subtitle: subtitle,
		hint:     "↑↓/Tab field · ←→ choose in protocol/thinking/model-list fields · Enter submit · Esc cancel",
		content:  strings.TrimSuffix(content.String(), "\n"),
		width:    frameWidth,
		rows:     rows,
		focusRow: focusRow,
	})
}

func (m Model) renderLoginDialog() string {
	if !m.loginDialog {
		return ""
	}
	return m.renderLoginFrame(m.dialogAvailableRows())
}
