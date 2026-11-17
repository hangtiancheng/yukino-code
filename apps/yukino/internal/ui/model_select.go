package ui

import (
	"context"
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/yukino-js/yukino/yukino/internal/config"
	"github.com/yukino-js/yukino/yukino/internal/llm"
)

// Port of src/ui/model-select.tsx.

type ModelPickerStatus string

const (
	ModelPickerLoading ModelPickerStatus = "loading"
	ModelPickerReady   ModelPickerStatus = "ready"
	ModelPickerEmpty   ModelPickerStatus = "empty"
	ModelPickerError   ModelPickerStatus = "error"
)

type modelPickerState struct {
	status ModelPickerStatus
	models []llm.DiscoveredModel
}

type modelDiscoveryDoneMsg struct {
	generation int
	models     []llm.DiscoveredModel
	err        error
}

// modelEntry mirrors the Entry union: a discovered model or the free-text row.
type modelEntry struct {
	kind  string // "model" | "other"
	model llm.DiscoveredModel
}

func modelFuseKeys() []fuseKey[llm.DiscoveredModel] {
	return []fuseKey[llm.DiscoveredModel]{
		{weight: 1, get: func(d llm.DiscoveredModel) (string, bool) { return d.ID, true }},
		{weight: 1, get: func(d llm.DiscoveredModel) (string, bool) { return d.DisplayName, d.DisplayName != "" }},
		{weight: 1, get: func(d llm.DiscoveredModel) (string, bool) { return d.Name, d.Name != "" }},
	}
}

func (m *Model) startModelDiscovery() tea.Cmd {
	if m.selectedProvider == nil {
		return nil
	}
	provider := *m.selectedProvider
	if m.modelDiscoveryCancel != nil {
		m.modelDiscoveryCancel()
	}
	ctx, cancel := context.WithCancel(m.lifeCtx)
	m.modelDiscoveryCancel = cancel
	m.modelDiscoveryGeneration++
	generation := m.modelDiscoveryGeneration
	return func() tea.Msg {
		models, err := llm.DiscoverModels(ctx, llm.DiscoveryConfig{
			Protocol: provider.Protocol,
			BaseURL:  provider.BaseURL,
			APIKey:   config.ResolveAPIKey(&provider),
		})
		return modelDiscoveryDoneMsg{generation: generation, models: models, err: err}
	}
}

func (m Model) openModelDialog() (tea.Model, tea.Cmd) {
	m.modelDialog = true
	m.modelState = modelPickerState{status: ModelPickerLoading}
	m.modelQuery = ""
	m.modelFocusedID = ""
	if m.selectedProvider != nil {
		m.modelFocusedID = m.selectedProvider.Model
	}
	m.modelFocusOther = false
	m.modelCustomMode = false
	m.modelCustomText = ""
	m.modelCustomCursor = 0
	return m, m.startModelDiscovery()
}

func (m Model) closeModelDialog() (tea.Model, tea.Cmd) {
	m.modelDialog = false
	if m.modelDiscoveryCancel != nil {
		m.modelDiscoveryCancel()
		m.modelDiscoveryCancel = nil
	}
	m.modelDiscoveryGeneration++
	return m, nil
}

// modelEntries lists the matched models followed by the free-text entry.
func (m Model) modelEntries() []modelEntry {
	query := strings.TrimSpace(m.modelQuery)
	var matched []llm.DiscoveredModel
	if query == "" {
		matched = m.modelState.models
	} else {
		matched = NewFuse(m.modelState.models, modelFuseKeys(), 0.35, true).Search(query)
	}
	entries := make([]modelEntry, 0, len(matched)+1)
	for _, model := range matched {
		entries = append(entries, modelEntry{kind: "model", model: model})
	}
	return append(entries, modelEntry{kind: "other"})
}

func (m Model) modelDialogCursor(entries []modelEntry) int {
	if m.modelFocusOther {
		return len(entries) - 1
	}
	for i, entry := range entries {
		if entry.kind == "model" && entry.model.ID == m.modelFocusedID {
			return i
		}
	}
	return 0
}

// modelForcedTextEntry reports whether discovery left the free-text field as
// the only dialog content.
func (m Model) modelForcedTextEntry() bool {
	return m.modelState.status == ModelPickerEmpty || m.modelState.status == ModelPickerError
}

func (m Model) handleModelDialog(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if m.modelCustomMode || m.modelForcedTextEntry() {
		return m.handleModelTextField(msg)
	}
	if msg.String() == "esc" {
		return m.closeModelDialog()
	}
	if m.modelState.status != ModelPickerReady {
		return m, nil
	}
	entries := m.modelEntries()
	cursor := m.modelDialogCursor(entries)
	switch msg.String() {
	case "up", "down":
		if len(entries) > 0 {
			next := cursor - 1
			if msg.String() == "down" {
				next = cursor + 1
			}
			next = (next + len(entries)) % len(entries)
			entry := entries[next]
			if entry.kind == "other" {
				m.modelFocusOther = true
				m.modelFocusedID = ""
			} else {
				m.modelFocusOther = false
				m.modelFocusedID = entry.model.ID
			}
		}
	case "enter":
		if cursor < len(entries) {
			entry := entries[cursor]
			if entry.kind == "other" {
				m.modelCustomMode = true
				m.modelCustomText = strings.TrimSpace(m.modelQuery)
				m.modelCustomCursor = len([]rune(m.modelCustomText))
			} else {
				return m.applyModelSelection(entry.model.ID)
			}
		}
	default:
		nextQuery := updateSelectorQuery(m.modelQuery, msg)
		if nextQuery != m.modelQuery {
			m.modelQuery = nextQuery
			m.modelFocusOther = false
			if strings.TrimSpace(nextQuery) != "" {
				m.modelFocusedID = ""
			} else if m.selectedProvider != nil {
				m.modelFocusedID = m.selectedProvider.Model
			}
		}
	}
	return m, nil
}

// handleModelTextField mirrors the TextField-owned keys while the free-text
// row is mounted.
func (m Model) handleModelTextField(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	value := m.modelCustomText
	runes := []rune(value)
	position := min(m.modelCustomCursor, len(runes))
	bounds := graphemeBounds(value)
	switch msg.String() {
	case "esc":
		return m.closeModelDialog()
	case "enter":
		id := strings.TrimSpace(m.modelCustomText)
		if id != "" {
			return m.applyModelSelection(id)
		}
		return m, nil
	case "left", "ctrl+b":
		m.modelCustomCursor = previousGraphemeBoundary(bounds, position)
	case "right", "ctrl+f":
		m.modelCustomCursor = nextGraphemeBoundary(bounds, position)
	case "home", "ctrl+a":
		m.modelCustomCursor = 0
	case "end", "ctrl+e":
		m.modelCustomCursor = len(runes)
	case "backspace":
		if position > 0 {
			previous := previousGraphemeBoundary(bounds, position)
			m.modelCustomText = string(runes[:previous]) + string(runes[position:])
			m.modelCustomCursor = previous
		}
	case "delete":
		if position < len(runes) {
			next := nextGraphemeBoundary(bounds, position)
			m.modelCustomText = string(runes[:position]) + string(runes[next:])
			m.modelCustomCursor = position
		}
	default:
		if len(msg.Runes) > 0 {
			inserted := []rune(strings.ReplaceAll(string(msg.Runes), "\n", " "))
			m.modelCustomText = string(runes[:position]) + string(inserted) + string(runes[position:])
			m.modelCustomCursor = position + len(inserted)
		}
	}
	return m, nil
}

func (m Model) applyModelSelection(modelID string) (tea.Model, tea.Cmd) {
	if m.modelDiscoveryCancel != nil {
		m.modelDiscoveryCancel()
		m.modelDiscoveryCancel = nil
	}
	m.modelDiscoveryGeneration++
	nextModel := strings.TrimSpace(modelID)
	if nextModel == "" || m.client == nil || m.selectedProvider == nil {
		return m, nil
	}
	if nextModel == m.selectedProvider.Model {
		m.modelDialog = false
		m.chatMessages = append(m.chatMessages, chatMessage{
			role:    "system",
			content: fmt.Sprintf("Model already set to %s.", nextModel),
		})
		return m, nil
	}
	updated := *m.selectedProvider
	updated.Model = nextModel
	return m.startProviderChange(updated, true)
}

// renderDialogTextField renders a free-text row: a dim prompt followed by the
// cursor-centered value.
func renderDialogTextField(prompt, value string, cursor, width int) string {
	window := cursorWindow(value, cursor, max(1, width-visibleWidth(prompt)))
	before := window.before
	if window.leadingEllipsis {
		before = "…" + before
	}
	after := window.after
	if window.trailingEllipsis {
		after += "…"
	}
	style := lipgloss.NewStyle().Foreground(normalText)
	return selectorHintStyle().Render(prompt) +
		style.Render(before) +
		cursorMarker + style.Render(window.current) +
		style.Render(after)
}

func (m Model) renderModelDialog() string {
	if !m.modelDialog {
		return ""
	}
	currentModel := ""
	if m.selectedProvider != nil {
		currentModel = m.selectedProvider.Model
	}
	rows := m.dialogAvailableRows()

	if m.modelForcedTextEntry() {
		status := "empty"
		if m.modelState.status == ModelPickerError {
			status = "error"
		}
		content := renderDialogTextField("Model id: ", m.modelCustomText, m.modelCustomCursor, max(1, m.width-4)) + "\n" +
			selectorHintStyle().Render("Any id is accepted, even one the provider does not list.")
		return m.renderSelectorFrame(selectorFrameParams{
			title:    "Select model",
			subtitle: StatusMessages[status] + " — type a model id",
			hint:     "Enter set model · Esc cancel",
			content:  content,
			width:    m.width,
			rows:     rows,
		})
	}

	if m.modelState.status != ModelPickerReady {
		return m.renderSelectorFrame(selectorFrameParams{
			title:    "Select model",
			subtitle: "Current model: " + currentModel,
			hint:     "Esc cancel",
			content:  lipgloss.NewStyle().Foreground(mutedText).Render(StatusMessages["loading"]),
			width:    m.width,
			rows:     rows,
		})
	}

	entries := m.modelEntries()
	cursor := m.modelDialogCursor(entries)
	hint := "↑↓ navigate · Enter select · Esc cancel"
	if m.modelCustomMode {
		hint = "Type model id · Enter select · Esc cancel"
	}
	selectedBg := lipgloss.Color(Theme.SelectedBg)
	return renderSelectorList(selectorListParams{
		title:        "Select model",
		hint:         hint,
		query:        m.modelQuery,
		emptyText:    "No models available",
		itemCount:    len(entries),
		itemHeight:   1,
		totalCount:   len(m.modelState.models),
		cursor:       cursor,
		searchActive: !m.modelCustomMode,
		width:        m.width,
		rows:         rows,
		renderRows: func(start, count, width int) string {
			var sb strings.Builder
			for i := start; i < start+count && i < len(entries); i++ {
				entry := entries[i]
				switch {
				case entry.kind == "other" && m.modelCustomMode:
					row := renderDialogTextField(Icons.Arrow+" Model id: ", m.modelCustomText, m.modelCustomCursor, max(0, width-2))
					sb.WriteString(lipgloss.NewStyle().Background(selectedBg).Width(width).Render(" " + row))
					sb.WriteString("\n")
				case entry.kind == "other":
					sb.WriteString(renderSelectorListRow(selectorListRowParams{
						label:   OtherLabel,
						focused: i == cursor,
						width:   width,
					}))
				default:
					detail := ""
					hasDetail := entry.model.DisplayName != "" && entry.model.DisplayName != entry.model.ID
					if hasDetail {
						detail = entry.model.DisplayName
					}
					sb.WriteString(renderSelectorListRow(selectorListRowParams{
						label:     entry.model.ID,
						detail:    detail,
						hasDetail: hasDetail,
						focused:   i == cursor,
						current:   entry.model.ID == currentModel,
						width:     width,
					}))
				}
			}
			return sb.String()
		},
	})
}
