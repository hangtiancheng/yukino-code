package sandbox

import (
	"context"
	"os/exec"
	"sync"

	"github.com/yukino-js/yukino/yukino/internal/utils"
)

type BwrapSandbox struct {
	once      sync.Once
	available bool
}

func (s *BwrapSandbox) Implementation() string { return "bwrap" }
func (s *BwrapSandbox) Available() bool {
	s.once.Do(func() { _, err := exec.LookPath("bwrap"); s.available = err == nil })
	return s.available
}
func (s *BwrapSandbox) Prepare(ctx context.Context, command string, config Config, cwd string) (PreparedCommand, error) {
	if err := ctx.Err(); err != nil {
		return PreparedCommand{}, err
	}
	args := []string{"--unshare-user", "--unshare-pid", "--die-with-parent", "--ro-bind", "/", "/"}
	for _, path := range config.AllowWrite {
		path = utils.ResolveToolPath(cwd, path)
		args = append(args, "--bind", path, path)
	}
	for _, path := range config.DenyWrite {
		path = utils.ResolveToolPath(cwd, path)
		args = append(args, "--ro-bind", path, path)
	}
	if !config.NetworkEnabled {
		args = append(args, "--unshare-net")
	}
	args = append(args, "--proc", "/proc", "--", "bash", "-c", command)
	return PreparedCommand{Executable: "bwrap", Args: args}, nil
}
