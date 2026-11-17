package ui

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
)

func TestThemesMatchReference(t *testing.T) {
	data, err := os.ReadFile("testdata/theme-expected.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Catppuccin map[string]map[string]string
		Palettes   map[string]map[string]string
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"dark", "light"} {
		t.Run(mode, func(t *testing.T) {
			colors := Catppuccin.Dark
			if mode == "light" {
				colors = Catppuccin.Light
			}
			assertThemeColors(t, colors, fixture.Catppuccin[mode])
			assertThemeColors(t, PaletteFor(ThemeMode(mode)), fixture.Palettes[mode])
		})
	}
}

func assertThemeColors(t *testing.T, got any, want map[string]string) {
	t.Helper()
	v := reflect.ValueOf(got)
	typ := v.Type()
	if typ.NumField() != len(want) {
		t.Fatalf("palette has %d fields, want %d", typ.NumField(), len(want))
	}
	for i := 0; i < typ.NumField(); i++ {
		name := typ.Field(i).Name
		key := strings.ToLower(name[:1]) + name[1:]
		if key == "mdLinkURL" {
			key = "mdLinkUrl"
		}
		expected, ok := want[key]
		if !ok {
			t.Errorf("unexpected palette field %q", name)
			continue
		}
		if field := v.Field(i).String(); field != expected {
			t.Errorf("%s = %q, want %q", name, field, expected)
		}
	}
}

func TestPaletteFor(t *testing.T) {
	if PaletteFor(ThemeModeDark) != DarkTheme {
		t.Fatal("dark mode must select DarkTheme")
	}
	if PaletteFor(ThemeModeLight) != LightTheme {
		t.Fatal("light mode must select LightTheme")
	}
	if Palettes.Dark != DarkTheme || Palettes.Light != LightTheme {
		t.Fatal("Palettes map must expose both themes")
	}
}
