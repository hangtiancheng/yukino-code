//go:build !windows

package github

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestRunGhExitAndTimeout(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "gh"), []byte("#!/bin/sh\ncase \"$1\" in\nexit) printf output; exit 7;;\nwait) sleep 10;;\nesac\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	res, err := RunGh(context.Background(), []string{"exit"}, GhOptions{})
	if err != nil || res.ExitCode != 7 || string(res.Stdout) != "output" || res.Signal != "" {
		t.Fatalf("exit result: %+v, %v", res, err)
	}
	res, err = RunGh(context.Background(), []string{"wait"}, GhOptions{TimeoutMS: 50})
	if err != nil || !res.TimedOut || res.Cancelled || res.Signal != "SIGKILL" {
		t.Fatalf("timeout result: %+v, %v", res, err)
	}
	result, _, err := handle(context.Background(), nil, Input{Args: []string{"wait"}, TimeoutMS: 50})
	if err != nil || !result.IsError {
		t.Fatalf("timeout call: %+v %v", result, err)
	}
	raw, _ := json.Marshal(result.StructuredContent)
	var data map[string]any
	_ = json.Unmarshal(raw, &data)
	if data["exit_code"] != nil || data["signal"] != "SIGKILL" {
		t.Fatalf("signaled process: %s", raw)
	}
}
