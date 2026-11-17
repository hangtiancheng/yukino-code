// Package version exposes the MCP server version reported during the MCP
// initialize handshake. The value defaults to the package version and can be
// overridden at build time with:
//
//	go build -ldflags "-X .../internal/version.Version=1.2.3"
package version

// Version is the semantic version advertised as serverInfo.version.
var Version = "0.0.1"
