package github

import (
	"bytes"
	"context"
	"strings"
	"time"
)

// GhResult is the outcome of one gh invocation, mirroring the TypeScript
// runner's result shape.
type GhResult struct {
	Stdout    []byte
	Stderr    string
	ExitCode  int
	Signal    string
	TimedOut  bool
	Cancelled bool
}

// GhOptions configures RunGh.
type GhOptions struct {
	Cwd       string
	Stdin     string
	TimeoutMS int
	Env       []string
}

// RunGh executes the gh CLI with the given arguments, capturing stdout/stderr
// and honouring the timeout and request cancellation. On POSIX the child runs
// in its own process group so cancellation can kill the whole group. Port of
// src/tools/github/runner.ts.
func RunGh(ctx context.Context, args []string, opts GhOptions) (GhResult, error) {
	timeout := time.Duration(opts.TimeoutMS) * time.Millisecond
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := execCommandContext(runCtx, "gh", args...)
	if opts.Cwd != "" {
		cmd.Dir = opts.Cwd
	}
	if opts.Env != nil {
		cmd.Env = opts.Env
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	cmd.Stdin = strings.NewReader(opts.Stdin)
	setProcGroup(cmd)
	cmd.Cancel = func() error {
		return killProcGroup(cmd)
	}

	runErr := cmd.Run()

	res := GhResult{
		Stdout:   stdout.Bytes(),
		Stderr:   stderr.String(),
		ExitCode: -1,
	}
	if cmd.ProcessState != nil {
		res.ExitCode = cmd.ProcessState.ExitCode()
		res.Signal = exitSignal(cmd.ProcessState)
	}
	res.TimedOut = runCtx.Err() == context.DeadlineExceeded
	res.Cancelled = !res.TimedOut && runCtx.Err() == context.Canceled

	if runErr != nil {
		if isSpawnError(runErr) {
			return res, runErr
		}
		// Exit errors, timeouts and cancellations are reported through the
		// result fields, not as Go errors.
		return res, nil
	}
	return res, nil
}
