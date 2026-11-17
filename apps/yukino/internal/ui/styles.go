package ui

import "github.com/charmbracelet/lipgloss"

var themeMode = ThemeModeDark

func GetThemeMode() ThemeMode { return themeMode }

func SetThemeMode(mode ThemeMode) {
	themeMode = mode
	Theme = PaletteFor(mode)
	accentColor = lipgloss.Color(Theme.Accent)
	dimText = lipgloss.Color(Theme.Dim)
	mutedText = lipgloss.Color(Theme.Muted)
	normalText = lipgloss.Color(Theme.Text)
	brightText = lipgloss.Color(Theme.Bright)
	greenText = lipgloss.Color(Theme.Success)
	redText = lipgloss.Color(Theme.Error)
	yellowText = lipgloss.Color(Theme.Warning)
	errorStyle = lipgloss.NewStyle().Foreground(redText).PaddingLeft(2)
	promptStyle = lipgloss.NewStyle().Foreground(accentColor).Bold(true)
}

func activityStatusColor(status string) lipgloss.Color {
	switch status {
	case "working":
		return lipgloss.Color(Theme.ThinkingHigh)
	case "retry":
		return lipgloss.Color(Theme.Warning)
	case "compacting":
		return lipgloss.Color(Theme.Accent)
	case "error":
		return lipgloss.Color(Theme.Error)
	}
	return lipgloss.Color(Theme.BorderMuted)
}

var (
	accentColor = lipgloss.Color(Theme.Accent)
	dimText     = lipgloss.Color(Theme.Dim)
	mutedText   = lipgloss.Color(Theme.Muted)
	normalText  = lipgloss.Color(Theme.Text)
	brightText  = lipgloss.Color(Theme.Bright)
	greenText   = lipgloss.Color(Theme.Success)
	redText     = lipgloss.Color(Theme.Error)
	yellowText  = lipgloss.Color(Theme.Warning)
	errorStyle  = lipgloss.NewStyle().Foreground(redText).PaddingLeft(2)
	promptStyle = lipgloss.NewStyle().Foreground(accentColor).Bold(true)
)
