package ui

// ThemePalette mirrors src/theme/constants.ts. Values match
// src/theme/palettes.js (Catppuccin Mocha for dark, Latte for light).
type ThemePalette struct {
	Accent             string
	AccentHover        string
	AccentBg           string
	Border             string
	BorderAccent       string
	BorderMuted        string
	Success            string
	SuccessBg          string
	Error              string
	ErrorBg            string
	Warning            string
	WarningBg          string
	Muted              string
	Dim                string
	Text               string
	ThinkingText       string
	SelectedBg         string
	UserMessageBg      string
	UserMessageText    string
	CustomMessageBg    string
	CustomMessageText  string
	CustomMessageLabel string
	ToolPendingBg      string
	ToolSuccessBg      string
	ToolErrorBg        string
	ToolStoppedBg      string
	ToolTitle          string
	ToolOutput         string
	MdHeading          string
	MdLink             string
	MdLinkURL          string
	MdCode             string
	MdCodeBlock        string
	MdCodeBlockBorder  string
	MdQuote            string
	MdQuoteBorder      string
	MdHr               string
	MdListBullet       string
	ToolDiffAdded      string
	ToolDiffRemoved    string
	ToolDiffContext    string
	SyntaxComment      string
	SyntaxKeyword      string
	SyntaxFunction     string
	SyntaxVariable     string
	SyntaxString       string
	SyntaxNumber       string
	SyntaxType         string
	SyntaxOperator     string
	SyntaxPunctuation  string
	ThinkingOff        string
	ThinkingMinimal    string
	ThinkingLow        string
	ThinkingMedium     string
	ThinkingHigh       string
	ThinkingMax        string
	BashMode           string
	ThinkingXHigh      string
	Background         string
	Surface            string
	CodeBg             string
	Bright             string
	AccentContrast     string
}

// ThemeMode mirrors src/theme/constants.ts ThemeMode.
type ThemeMode string

const (
	ThemeModeDark  ThemeMode = "dark"
	ThemeModeLight ThemeMode = "light"
)

var DarkTheme = buildPalette(Catppuccin.Dark)
var LightTheme = buildPalette(Catppuccin.Light)

// Palettes mirrors src/theme/constants.ts PALETTES.
var Palettes = struct {
	Dark  ThemePalette
	Light ThemePalette
}{Dark: DarkTheme, Light: LightTheme}

// PaletteFor mirrors the reference palette selection by mode.
func PaletteFor(mode ThemeMode) ThemePalette {
	if mode == ThemeModeLight {
		return LightTheme
	}
	return DarkTheme
}

// Theme is the active palette; the terminal UI defaults to the dark theme.
var Theme = DarkTheme
