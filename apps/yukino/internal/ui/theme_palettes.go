package ui

import (
	"fmt"
	"math"
	"strconv"
)

type CatppuccinPalette struct {
	Rosewater, Flamingo, Pink, Mauve, Red, Maroon, Peach, Yellow string
	Green, Teal, Sky, Sapphire, Blue, Lavender                   string
	Text, Subtext1, Subtext0, Overlay2, Overlay1, Overlay0       string
	Surface2, Surface1, Surface0, Base, Mantle, Crust            string
}

var Catppuccin = struct {
	Dark, Light CatppuccinPalette
}{
	Dark: CatppuccinPalette{
		Rosewater: "#f5e0dc", Flamingo: "#f2cdcd", Pink: "#f5c2e7", Mauve: "#cba6f7",
		Red: "#f38ba8", Maroon: "#eba0ac", Peach: "#fab387", Yellow: "#f9e2af",
		Green: "#a6e3a1", Teal: "#94e2d5", Sky: "#89dceb", Sapphire: "#74c7ec",
		Blue: "#89b4fa", Lavender: "#b4befe", Text: "#cdd6f4", Subtext1: "#bac2de",
		Subtext0: "#a6adc8", Overlay2: "#9399b2", Overlay1: "#7f849c", Overlay0: "#6c7086",
		Surface2: "#585b70", Surface1: "#45475a", Surface0: "#313244",
		Base: "#1e1e2e", Mantle: "#181825", Crust: "#11111b",
	},
	Light: CatppuccinPalette{
		Rosewater: "#dc8a78", Flamingo: "#dd7878", Pink: "#ea76cb", Mauve: "#8839ef",
		Red: "#d20f39", Maroon: "#e64553", Peach: "#fe640b", Yellow: "#df8e1d",
		Green: "#40a02b", Teal: "#179299", Sky: "#04a5e5", Sapphire: "#209fb5",
		Blue: "#1e66f5", Lavender: "#7287fd", Text: "#4c4f69", Subtext1: "#5c5f77",
		Subtext0: "#6c6f85", Overlay2: "#7c7f93", Overlay1: "#8c8fa1", Overlay0: "#9ca0b0",
		Surface2: "#acb0be", Surface1: "#bcc0cc", Surface0: "#ccd0da",
		Base: "#eff1f5", Mantle: "#e6e9ef", Crust: "#dce0e8",
	},
}

func colorChannels(color string) [3]float64 {
	var channels [3]float64
	for i := range channels {
		value, _ := strconv.ParseUint(color[1+i*2:3+i*2], 16, 8)
		channels[i] = float64(value)
	}
	return channels
}

func mixColor(background, foreground string, amount float64) string {
	base, tint := colorChannels(background), colorChannels(foreground)
	var channels [3]int
	for i := range channels {
		channels[i] = int(math.Round(base[i] + (tint[i]-base[i])*amount))
	}
	return fmt.Sprintf("#%02x%02x%02x", channels[0], channels[1], channels[2])
}

func colorLuminance(color string) float64 {
	channels := colorChannels(color)
	for i, value := range channels {
		channel := value / 255
		if channel <= 0.04045 {
			channels[i] = channel / 12.92
		} else {
			channels[i] = math.Pow((channel+0.055)/1.055, 2.4)
		}
	}
	return channels[0]*0.2126 + channels[1]*0.7152 + channels[2]*0.0722
}

func readableColor(color, background, text string) string {
	backgroundLuminance := colorLuminance(background)
	target := "#ffffff"
	if backgroundLuminance > colorLuminance(color) {
		target = "#000000"
	}
	for step := 0; step <= 20; step++ {
		candidate := mixColor(color, target, float64(step)/20)
		candidateLuminance := colorLuminance(candidate)
		contrast := (max(candidateLuminance, backgroundLuminance) + 0.05) / (min(candidateLuminance, backgroundLuminance) + 0.05)
		if contrast >= 4.5 {
			return candidate
		}
	}
	return text
}

func buildPalette(colors CatppuccinPalette) ThemePalette {
	surfaceBase := mixColor(colors.Base, "#ffffff", 0.08)
	surface := func(color string) string { return mixColor(surfaceBase, color, 0.08) }
	selectedBg := mixColor(colors.Base, colors.Teal, 0.16)
	surfaces := []string{colors.Teal, colors.Green, colors.Red, colors.Yellow, colors.Blue, colors.Mauve}
	for i, color := range surfaces {
		surfaces[i] = surface(color)
	}
	surfaces = append(surfaces, selectedBg)
	foreground := func(color string) string {
		for _, background := range surfaces {
			color = readableColor(color, background, colors.Text)
		}
		return color
	}
	accent := foreground(colors.Teal)
	success := foreground(colors.Green)
	warning := foreground(colors.Yellow)
	errorColor := foreground(colors.Red)
	heading := foreground(colors.Mauve)
	return ThemePalette{
		Background:         colors.Base,
		Surface:            colors.Mantle,
		CodeBg:             colors.Mantle,
		Border:             colors.Surface2,
		BorderMuted:        colors.Surface0,
		BorderAccent:       accent,
		Text:               colors.Text,
		Bright:             colors.Text,
		Muted:              colors.Subtext1,
		Dim:                readableColor(colors.Subtext0, colors.Mantle, colors.Text),
		Accent:             accent,
		AccentHover:        mixColor(accent, colors.Text, 0.12),
		AccentContrast:     colors.Base,
		AccentBg:           surface(colors.Teal),
		Success:            success,
		SuccessBg:          surface(colors.Green),
		Warning:            warning,
		WarningBg:          surface(colors.Yellow),
		Error:              errorColor,
		ErrorBg:            surface(colors.Red),
		SelectedBg:         selectedBg,
		UserMessageBg:      surface(colors.Blue),
		UserMessageText:    colors.Text,
		CustomMessageBg:    surface(colors.Mauve),
		CustomMessageText:  colors.Text,
		CustomMessageLabel: heading,
		ToolPendingBg:      surface(colors.Blue),
		ToolSuccessBg:      surface(colors.Green),
		ToolErrorBg:        surface(colors.Red),
		ToolStoppedBg:      surface(colors.Yellow),
		ToolTitle:          colors.Text,
		ToolOutput:         foreground(colors.Subtext1),
		ToolDiffAdded:      success,
		ToolDiffRemoved:    errorColor,
		ToolDiffContext:    foreground(colors.Subtext0),
		ThinkingText:       colors.Subtext0,
		ThinkingOff:        colors.Subtext0,
		ThinkingMinimal:    colors.Subtext1,
		ThinkingLow:        foreground(colors.Blue),
		ThinkingMedium:     accent,
		ThinkingHigh:       heading,
		ThinkingXHigh:      foreground(colors.Lavender),
		ThinkingMax:        foreground(colors.Pink),
		BashMode:           success,
		MdHeading:          heading,
		MdLink:             foreground(colors.Blue),
		MdLinkURL:          colors.Subtext0,
		MdCode:             accent,
		MdCodeBlock:        colors.Text,
		MdCodeBlockBorder:  colors.Surface2,
		MdQuote:            colors.Subtext0,
		MdQuoteBorder:      colors.Surface2,
		MdHr:               colors.Surface2,
		MdListBullet:       accent,
		SyntaxComment:      foreground(colors.Overlay2),
		SyntaxKeyword:      heading,
		SyntaxFunction:     foreground(colors.Blue),
		SyntaxVariable:     colors.Text,
		SyntaxString:       success,
		SyntaxNumber:       foreground(colors.Peach),
		SyntaxType:         warning,
		SyntaxOperator:     foreground(colors.Sky),
		SyntaxPunctuation:  foreground(colors.Overlay2),
	}
}
