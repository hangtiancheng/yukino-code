// Package version resolves the application version, mirroring src/version.ts.
package version

// Version matches the reference package.json version; release builds may
// override it via -ldflags "-X .../version.Version=...".
var Version = "latest"
