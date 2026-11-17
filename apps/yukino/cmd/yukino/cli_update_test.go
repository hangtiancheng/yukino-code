package main

import (
	"strings"
	"testing"
)

func TestParseUpdateArgs(t *testing.T) {
	tag, help, err := parseUpdateArgs(nil)
	if err != nil || help || tag != nil {
		t.Fatalf("bare update: tag=%v help=%v err=%v", tag, help, err)
	}

	tag, help, err = parseUpdateArgs([]string{"--tag", "canary"})
	if err != nil || help || tag == nil || *tag != "canary" {
		t.Fatalf("--tag canary: tag=%v help=%v err=%v", tag, help, err)
	}

	tag, help, err = parseUpdateArgs([]string{"--tag=canary"})
	if err != nil || help || tag == nil || *tag != "canary" {
		t.Fatalf("--tag=canary: tag=%v help=%v err=%v", tag, help, err)
	}

	// Explicit empty tag is preserved (the registry check rejects it).
	tag, help, err = parseUpdateArgs([]string{"--tag="})
	if err != nil || help || tag == nil || *tag != "" {
		t.Fatalf("--tag=: tag=%v help=%v err=%v", tag, help, err)
	}

	for _, args := range [][]string{{"--help"}, {"-h"}} {
		_, help, err = parseUpdateArgs(args)
		if err != nil || !help {
			t.Fatalf("%v: help=%v err=%v", args, help, err)
		}
	}

	for _, args := range [][]string{
		{"--tag"},
		{"--tag", "-x"},
		{"--unknown"},
		{"stray"},
	} {
		_, _, err = parseUpdateArgs(args)
		if err == nil {
			t.Fatalf("%v: expected error", args)
		}
		if !strings.Contains(err.Error(), updateUsage) {
			t.Fatalf("%v: error %q should include usage", args, err)
		}
	}
}
