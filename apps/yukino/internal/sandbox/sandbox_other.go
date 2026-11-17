//go:build !darwin && !linux

package sandbox

func newPlatformSandbox() Sandbox { return nil }
