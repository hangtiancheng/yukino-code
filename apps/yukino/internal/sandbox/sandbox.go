package sandbox

import "context"

type Sandbox interface {
	Implementation() string
	Prepare(context.Context, string, Config, string) (PreparedCommand, error)
	Available() bool
}

type PreparedCommand struct {
	Executable     string
	Args           []string
	Env            []string
	AnnotateOutput func(string) string
	Cleanup        func() error
}

type Config struct {
	AllowWrite     []string
	DenyWrite      []string
	NetworkEnabled bool
}

func New() Sandbox { return newPlatformSandbox() }
