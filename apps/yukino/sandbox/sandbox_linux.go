//go:build linux

package sandbox

func newPlatformSandbox() Sandbox { return &BwrapSandbox{} }
