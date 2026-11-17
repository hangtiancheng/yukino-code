package main

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

func TestCLIReference(t *testing.T) {
	raw, err := os.ReadFile("testdata/cli-expected.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures struct {
		Cases []struct {
			Args     []string       `json:"args"`
			Expected map[string]any `json:"expected"`
			Error    string         `json:"error"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, c := range fixtures.Cases {
		mode, err := parseCliArgs(c.Args)
		if c.Error != "" {
			if err == nil || err.Error() != c.Error {
				t.Errorf("%q: error %v, want %q", c.Args, err, c.Error)
			}
			continue
		}
		if err != nil {
			t.Errorf("%q: %v", c.Args, err)
			continue
		}
		serialized, _ := json.Marshal(mode)
		var got map[string]any
		json.Unmarshal(serialized, &got)
		if !reflect.DeepEqual(got, c.Expected) {
			t.Errorf("%q: got %s, want %v", c.Args, serialized, c.Expected)
		}
	}
}
