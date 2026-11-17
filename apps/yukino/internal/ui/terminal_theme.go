package ui

import (
	"fmt"
	"io"
	"math"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/charmbracelet/x/term"
)

type rgbColor struct{ r, g, b int }

var colorSchemeReport = regexp.MustCompile("\x1b\\[\\?997;(1|2)n")
var osc11Report = regexp.MustCompile("(?i)\x1b\\]11;([^\x07\x1b]*)(?:\x07|\x1b\\\\)")
var hexChannel = regexp.MustCompile(`(?i)^[0-9a-f]+$`)
var decimalChannel = regexp.MustCompile(`^\d+$`)

func parseTerminalColorSchemeReport(data string) ThemeMode {
	match := colorSchemeReport.FindStringSubmatch(data)
	if len(match) == 0 {
		return ""
	}
	if match[1] == "2" {
		return ThemeModeLight
	}
	return ThemeModeDark
}

func parseOsc11BackgroundColor(data string) (rgbColor, bool) {
	match := osc11Report.FindStringSubmatch(data)
	if len(match) == 0 {
		return rgbColor{}, false
	}
	value := strings.TrimSpace(match[1])
	if strings.HasPrefix(value, "#") && len(value) == 7 && hexChannel.MatchString(value[1:]) {
		var color rgbColor
		_, err := fmt.Sscanf(value, "#%02x%02x%02x", &color.r, &color.g, &color.b)
		return color, err == nil
	}
	lower := strings.ToLower(value)
	if strings.HasPrefix(lower, "rgba:") {
		value = value[5:]
	} else if strings.HasPrefix(lower, "rgb:") {
		value = value[4:]
	}
	channels := strings.Split(value, "/")
	if len(channels) < 3 {
		return rgbColor{}, false
	}
	var values [3]int
	for i := range values {
		channel := channels[i]
		if !hexChannel.MatchString(channel) {
			return rgbColor{}, false
		}
		number := 0.0
		for _, digit := range strings.ToLower(channel) {
			v := digit - '0'
			if digit >= 'a' {
				v = digit - 'a' + 10
			}
			number = number*16 + float64(v)
		}
		values[i] = int(math.Round(number / (math.Pow(16, float64(len(channel))) - 1) * 255))
	}
	return rgbColor{values[0], values[1], values[2]}, true
}

func themeForRGB(color rgbColor) ThemeMode {
	luminance := func(channel int) float64 {
		value := float64(channel) / 255
		if value <= 0.03928 {
			return value / 12.92
		}
		return math.Pow((value+0.055)/1.055, 2.4)
	}
	if 0.2126*luminance(color.r)+0.7152*luminance(color.g)+0.0722*luminance(color.b) >= 0.5 {
		return ThemeModeLight
	}
	return ThemeModeDark
}

func ansiBackgroundColor(index int) rgbColor {
	base := [...]rgbColor{{0, 0, 0}, {128, 0, 0}, {0, 128, 0}, {128, 128, 0}, {0, 0, 128}, {128, 0, 128}, {0, 128, 128}, {192, 192, 192}, {128, 128, 128}, {255, 0, 0}, {0, 255, 0}, {255, 255, 0}, {0, 0, 255}, {255, 0, 255}, {0, 255, 255}, {255, 255, 255}}
	if index < 16 {
		if index < 0 {
			return base[0]
		}
		return base[index]
	}
	if index >= 232 {
		value := 8 + (index-232)*10
		return rgbColor{value, value, value}
	}
	levels := [...]int{0, 95, 135, 175, 215, 255}
	cube := index - 16
	return rgbColor{levels[cube/36], levels[cube%36/6], levels[cube%6]}
}

func themeFromEnvironment(colorFGBG string) ThemeMode {
	parts := strings.Split(colorFGBG, ";")
	for i := len(parts) - 1; i >= 0; i-- {
		if !decimalChannel.MatchString(strings.TrimSpace(parts[i])) {
			continue
		}
		index, err := strconv.Atoi(strings.TrimSpace(parts[i]))
		if err != nil {
			return ThemeModeDark
		}
		return themeForRGB(ansiBackgroundColor(index))
	}
	return ""
}

func DetectTerminalTheme(input *TerminalInput, output *os.File, preference string) ThemeMode {
	if preference == "dark" || preference == "light" {
		return ThemeMode(preference)
	}
	if mode := themeFromEnvironment(os.Getenv("COLORFGBG")); mode != "" {
		return mode
	}
	if !input.isTTY || !term.IsTerminal(output.Fd()) {
		return ThemeModeDark
	}
	if _, err := io.WriteString(output, "\x1b[?996n\x1b]11;?\x07"); err != nil {
		return ThemeModeDark
	}
	timer := time.NewTimer(100 * time.Millisecond)
	defer timer.Stop()
	background := ThemeModeDark
	for {
		select {
		case report := <-input.reports:
			if mode := parseTerminalColorSchemeReport(report); mode != "" {
				return mode
			}
			if color, ok := parseOsc11BackgroundColor(report); ok {
				background = themeForRGB(color)
			}
		case <-timer.C:
			return background
		}
	}
}
