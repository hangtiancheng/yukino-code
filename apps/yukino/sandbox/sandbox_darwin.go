//go:build darwin

package sandbox

func newPlatformSandbox() Sandbox { return &SeatbeltSandbox{} }
