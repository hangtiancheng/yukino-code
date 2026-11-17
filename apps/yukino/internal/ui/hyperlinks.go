package ui

import (
	"os"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"

	"github.com/charmbracelet/x/term"
)

// Port of the supports-hyperlinks package: the reference markdown renderer
// emits OSC-8 hyperlinks only when supportsHyperlinks.stdout is true.

type hyperlinkVersion struct {
	major int
	minor int
}

var digitsOnlyVersion = regexp.MustCompile(`^\d{3,4}$`)
var splitVersionGroups = regexp.MustCompile(`(\d{1,2})(\d{2})`)
var nixWezTermVersion = regexp.MustCompile(`^0-unstable-(\d{4}-\d{2}-\d{2})$`)

// parseHyperlinkVersion mirrors the package's parseVersion: a bare 3-4 digit
// value splits into minor.patch with major 0 (e.g. 4601 => 0.46.1); anything
// else splits on dots.
func parseHyperlinkVersion(value string) hyperlinkVersion {
	if digitsOnlyVersion.MatchString(value) {
		match := splitVersionGroups.FindStringSubmatch(value)
		if match == nil {
			return hyperlinkVersion{}
		}
		minor, _ := strconv.Atoi(match[1])
		return hyperlinkVersion{major: 0, minor: minor}
	}
	parts := strings.Split(value, ".")
	version := hyperlinkVersion{}
	if len(parts) > 0 {
		version.major, _ = strconv.Atoi(strings.TrimSpace(parts[0]))
	}
	if len(parts) > 1 {
		version.minor, _ = strconv.Atoi(strings.TrimSpace(parts[1]))
	}
	return version
}

func hasHyperlinkFlag(flags ...string) bool {
	for _, arg := range os.Args {
		for _, flag := range flags {
			if arg == flag {
				return true
			}
		}
	}
	return false
}

// supportsColorForStdout approximates the supports-color gate the package
// applies before the terminal checks: no color means no hyperlinks.
func supportsColorForStdout() bool {
	if os.Getenv("NO_COLOR") != "" {
		return false
	}
	if os.Getenv("TERM") == "dumb" {
		return false
	}
	return true
}

func detectHyperlinkSupport() bool {
	if force := os.Getenv("FORCE_HYPERLINK"); force != "" {
		parsed, err := strconv.Atoi(force)
		return !(err == nil && parsed == 0)
	}
	if hasHyperlinkFlag("--no-hyperlink", "--no-hyperlinks", "--hyperlink=false", "--hyperlink=never") {
		return false
	}
	if hasHyperlinkFlag("--hyperlink=true", "--hyperlink=always") {
		return true
	}
	// Netlify does not run a TTY; it does not need the color check.
	if os.Getenv("NETLIFY") != "" {
		return true
	}
	if !supportsColorForStdout() {
		return false
	}
	if !term.IsTerminal(os.Stdout.Fd()) {
		return false
	}
	// Windows Terminal.
	if _, ok := os.LookupEnv("WT_SESSION"); ok {
		return true
	}
	if runtime.GOOS == "windows" {
		return false
	}
	if os.Getenv("CI") != "" {
		return false
	}
	if os.Getenv("TEAMCITY_VERSION") != "" {
		return false
	}
	if program := os.Getenv("TERM_PROGRAM"); program != "" {
		programVersion := os.Getenv("TERM_PROGRAM_VERSION")
		version := parseHyperlinkVersion(programVersion)
		switch program {
		case "iTerm.app":
			if version.major == 3 {
				return version.minor >= 1
			}
			return version.major > 3
		case "WezTerm":
			// WezTerm packaged by Nix uses its own version scheme.
			if match := nixWezTermVersion.FindStringSubmatch(programVersion); match != nil {
				return match[1] >= "2020-06-20"
			}
			return version.major >= 20200620
		case "vscode":
			// Cursor forked VS Code and supports hyperlinks in 0.x.x.
			if os.Getenv("CURSOR_TRACE_ID") != "" {
				return true
			}
			return version.major > 1 || version.major == 1 && version.minor >= 72
		case "ghostty", "zed", "Orca", "WarpTerminal":
			return true
		}
	}
	if vte := os.Getenv("VTE_VERSION"); vte != "" {
		// 0.50.0 was supposed to support hyperlinks, but throws a segfault.
		if vte == "0.50.0" {
			return false
		}
		version := parseHyperlinkVersion(vte)
		return version.major > 0 || version.minor >= 50
	}
	switch os.Getenv("TERM") {
	case "alacritty", "xterm-kitty":
		return true
	}
	return false
}

var (
	hyperlinkOnce    sync.Once
	hyperlinkSupport bool
)

// supportsHyperlinks mirrors supportsHyperlinks.stdout, evaluated once per
// process like the reference's module-level constant.
func supportsHyperlinks() bool {
	hyperlinkOnce.Do(func() {
		hyperlinkSupport = detectHyperlinkSupport()
	})
	return hyperlinkSupport
}

var oscHrefSpace = regexp.MustCompile("[ \t]")
var oscHrefControl = regexp.MustCompile("[\x00-\x1f\x7f]")

// oscSafeHref mirrors the reference: OSC-8 targets must not contain raw
// whitespace or control characters, but a literal "+" is a valid URL
// character and must not be rewritten the way form encoding would.
func oscSafeHref(href string) string {
	return oscHrefControl.ReplaceAllString(oscHrefSpace.ReplaceAllString(href, "%20"), "")
}

// osc8Link wraps text in an OSC-8 hyperlink (the ansi-escapes link format).
func osc8Link(text, href string) string {
	return "\x1b]8;;" + href + "\x07" + text + "\x1b]8;;\x07"
}
